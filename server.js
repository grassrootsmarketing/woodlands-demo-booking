require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Stripe = require('stripe');
const { Resend } = require('resend');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve success page
app.get('/success', (req, res) => {
  res.sendFile('success.html', { root: path.join(__dirname, 'public') });
});

// Create Stripe Checkout Session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { cart, customerEmail, customerName, company, product, phone } = req.body;
    
    const totalAmount = cart.length * 30 * 100; // $30 per demo in cents
    
    // Create line items for Stripe
    const lineItems = cart.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Demo at Woodlands Market - ${item.location}`,
          description: `${item.displayDate} • ${item.time}`,
        },
        unit_amount: 3000, // $30 in cents
      },
      quantity: 1,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      customer_email: customerEmail,
      metadata: (() => {
        const meta = { customerName, company, product, phone };
        const slim = cart.map(b => ({
          date: b.date || b.dateStr,
          time: b.time,
          location: b.location,
          displayDate: b.displayDate
        }));
        // Stripe metadata values max 500 chars — split across keys if needed
        const bookingsStr = JSON.stringify(slim);
        if (bookingsStr.length <= 500) {
          meta.bookings = bookingsStr;
        } else {
          // Split into chunks across multiple metadata keys
          for (let i = 0; i < bookingsStr.length; i += 500) {
            meta[`bookings_${Math.floor(i / 500)}`] = bookingsStr.slice(i, i + 500);
          }
          meta.bookings_chunks = String(Math.ceil(bookingsStr.length / 500));
        }
        return meta;
      })(),
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error.type, error.message);
    res.status(500).json({ error: error.message, type: error.type || 'unknown' });
  }
});

// Handle successful payment - verify and send email
app.get('/api/verify-payment/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status === 'paid') {
      // Reassemble bookings from metadata (may be chunked)
      let bookingsStr;
      if (session.metadata.bookings) {
        bookingsStr = session.metadata.bookings;
      } else {
        const chunks = parseInt(session.metadata.bookings_chunks || '0');
        bookingsStr = '';
        for (let i = 0; i < chunks; i++) {
          bookingsStr += session.metadata[`bookings_${i}`] || '';
        }
      }
      const bookings = JSON.parse(bookingsStr);
      const confirmationNumber = `WM-${Date.now().toString().slice(-8)}`;
      
      // Send confirmation email
      await sendConfirmationEmail({
        to: session.customer_email,
        customerName: session.metadata.customerName,
        company: session.metadata.company,
        product: session.metadata.product,
        bookings,
        confirmationNumber,
        totalPaid: (session.amount_total / 100).toFixed(2),
      });

      res.json({
        success: true,
        confirmationNumber,
        bookings,
        customerEmail: session.customer_email,
      });
    } else {
      res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send confirmation email with calendar links
async function sendConfirmationEmail({ to, customerName, company, product, bookings, confirmationNumber, totalPaid }) {
  const bookingsList = bookings.map(b => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #e8e0d5;">${b.displayDate}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e8e0d5;">${b.time}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e8e0d5;">Woodlands Market - ${b.location}</td>
    </tr>
  `).join('');

  // Generate ICS content for calendar attachment
  const icsContent = generateICS(bookings, company, product);
  const icsBase64 = Buffer.from(icsContent).toString('base64');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a3a21; }
        .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
        .header { text-align: center; margin-bottom: 32px; }
        .logo { width: 60px; height: 60px; background: linear-gradient(135deg, #2d6339, #234d2c); border-radius: 12px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; color: white; font-size: 24px; font-weight: bold; }
        .success-badge { display: inline-block; background: #d4edda; color: #2d6339; padding: 8px 16px; border-radius: 20px; font-weight: 600; margin-bottom: 16px; }
        h1 { color: #1a3a21; margin: 0 0 8px; }
        .details-box { background: #faf8f5; border-radius: 12px; padding: 24px; margin: 24px 0; }
        .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e8e0d5; }
        .detail-row:last-child { border-bottom: none; }
        .detail-label { color: #7a6352; }
        .detail-value { font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; }
        th { text-align: left; padding: 12px; background: #eef7f0; color: #2d6339; font-size: 12px; text-transform: uppercase; }
        .calendar-btn { display: inline-block; background: #2d6339; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; margin: 8px 4px; }
        .calendar-btn:hover { background: #234d2c; }
        .footer { text-align: center; margin-top: 32px; padding-top: 24px; border-top: 1px solid #e8e0d5; color: #7a6352; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">WM</div>
          <span class="success-badge">✓ Confirmed</span>
          <h1>Your Demo is Booked!</h1>
          <p style="color: #7a6352; margin: 0;">Thanks for booking with Woodlands Market</p>
        </div>

        <div class="details-box">
          <div class="detail-row">
            <span class="detail-label">Confirmation #</span>
            <span class="detail-value">${confirmationNumber}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Company</span>
            <span class="detail-value">${company}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Product</span>
            <span class="detail-value">${product}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Total Paid</span>
            <span class="detail-value">$${totalPaid}</span>
          </div>
        </div>

        <h3 style="margin-bottom: 8px;">Your Scheduled Demos</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            ${bookingsList}
          </tbody>
        </table>

        <div style="text-align: center; margin: 32px 0;">
          <p style="margin-bottom: 16px; color: #7a6352;">Add to your calendar:</p>
          <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Demo at Woodlands Market')}" class="calendar-btn" target="_blank">Google Calendar</a>
        </div>

        <div class="footer">
          <p><strong>Woodlands Market</strong></p>
          <p>Questions? Contact us at demos@woodlandsmarket.com</p>
          <p style="margin-top: 16px; font-size: 12px;">All bookings are final. No cancellations, edits, or refunds.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await resend.emails.send({
      from: 'Woodlands Market <bookings@woodlandsmarket.com>',
      to: [to],
      subject: `Demo Confirmed - ${confirmationNumber}`,
      html,
      attachments: [
        {
          filename: 'woodlands-demo.ics',
          content: icsBase64,
        },
      ],
    });
    console.log('Confirmation email sent to:', to);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Generate ICS calendar file content
function generateICS(bookings, company, product) {
  let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Woodlands Market//Demo Scheduling//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
`;

  bookings.forEach((item, index) => {
    const date = new Date(item.date);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    let hours = parseInt(item.time.split(':')[0]);
    const isPM = item.time.includes('PM');
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    
    const startHour = String(hours).padStart(2, '0');
    const endHour = String(hours + 3).padStart(2, '0');
    const uid = `wm-demo-${Date.now()}-${index}@woodlandsmarket.com`;

    ics += `BEGIN:VEVENT
DTSTART:${year}${month}${day}T${startHour}0000
DTEND:${year}${month}${day}T${endHour}0000
SUMMARY:Product Demo - ${company}
LOCATION:Woodlands Market, ${item.location}, CA
DESCRIPTION:Product: ${product}\\n3-hour product demonstration slot.
UID:${uid}
STATUS:CONFIRMED
END:VEVENT
`;
  });

  ics += `END:VCALENDAR`;
  return ics;
}

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
