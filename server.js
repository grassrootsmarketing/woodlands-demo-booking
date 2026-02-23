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

// ============================================================
// ADMIN API ENDPOINTS
// ============================================================

// Simple admin auth middleware
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.admin_password;
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

// Helper: extract bookings from Stripe session metadata
function extractBookings(session) {
  try {
    let bookingsStr;
    if (session.metadata.bookings) {
      bookingsStr = session.metadata.bookings;
    } else if (session.metadata.bookings_chunks) {
      const chunks = parseInt(session.metadata.bookings_chunks);
      bookingsStr = '';
      for (let i = 0; i < chunks; i++) {
        bookingsStr += session.metadata[`bookings_${i}`] || '';
      }
    }
    return bookingsStr ? JSON.parse(bookingsStr) : [];
  } catch (e) {
    return [];
  }
}

// GET /api/admin/bookings - List all bookings from Stripe
app.get('/api/admin/bookings', adminAuth, async (req, res) => {
  try {
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      expand: ['data.payment_intent'],
    });

    const bookings = sessions.data
      .filter(s => s.payment_status === 'paid' && s.metadata.customerName)
      .map(s => {
        const refund = s.payment_intent?.charges?.data?.[0]?.refunded || false;
        const refundAmount = s.payment_intent?.charges?.data?.[0]?.amount_refunded || 0;
        return {
          id: s.id,
          paymentIntentId: s.payment_intent?.id || s.payment_intent,
          customerName: s.metadata.customerName,
          email: s.customer_email,
          company: s.metadata.company,
          product: s.metadata.product,
          phone: s.metadata.phone,
          bookings: extractBookings(s),
          totalAmount: (s.amount_total / 100).toFixed(2),
          createdAt: new Date(s.created * 1000).toISOString(),
          status: refund ? 'refunded' : 'confirmed',
          refundAmount: (refundAmount / 100).toFixed(2),
        };
      });

    res.json({ bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/stats - Dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startTimestamp = Math.floor(startOfMonth.getTime() / 1000);

    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: startTimestamp },
    });

    const paidSessions = sessions.data.filter(s => s.payment_status === 'paid' && s.metadata.customerName);
    let totalDemos = 0;
    let totalRevenue = 0;

    paidSessions.forEach(s => {
      const bookings = extractBookings(s);
      totalDemos += bookings.length;
      totalRevenue += s.amount_total / 100;
    });

    // Revenue split: $20/demo to Woodlands Market, $10/demo to Grassroots
    const marketShare = totalDemos * 20;
    const grassrootsShare = totalDemos * 10;

    res.json({
      thisMonthDemos: totalDemos,
      totalRevenue: totalRevenue.toFixed(2),
      marketShare: marketShare.toFixed(2),
      grassrootsShare: grassrootsShare.toFixed(2),
      demoFee: '30.00',
      marketPerDemo: '20.00',
      grassrootsPerDemo: '10.00',
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/analytics - Full analytics data
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    // Fetch all sessions (paginate up to 300)
    let allSessions = [];
    let hasMore = true;
    let startingAfter = null;
    while (hasMore && allSessions.length < 300) {
      const params = { limit: 100, expand: ['data.payment_intent'] };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.checkout.sessions.list(params);
      allSessions = allSessions.concat(batch.data);
      hasMore = batch.has_more;
      if (batch.data.length > 0) startingAfter = batch.data[batch.data.length - 1].id;
    }

    const paid = allSessions.filter(s => s.payment_status === 'paid' && s.metadata.customerName);
    const notRefunded = paid.filter(s => {
      const refunded = s.payment_intent?.charges?.data?.[0]?.refunded || false;
      return !refunded;
    });

    // Monthly revenue (last 6 months)
    const monthlyData = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      monthlyData[key] = { revenue: 0, demos: 0, market: 0, grassroots: 0 };
    }
    notRefunded.forEach(s => {
      const created = new Date(s.created * 1000);
      const key = created.getFullYear() + '-' + String(created.getMonth() + 1).padStart(2, '0');
      if (monthlyData[key]) {
        const bookings = extractBookings(s);
        const numDemos = bookings.length;
        monthlyData[key].revenue += s.amount_total / 100;
        monthlyData[key].demos += numDemos;
        monthlyData[key].market += numDemos * 20;
        monthlyData[key].grassroots += numDemos * 10;
      }
    });

    // Location breakdown
    const locationData = {};
    notRefunded.forEach(s => {
      const bookings = extractBookings(s);
      bookings.forEach(b => {
        const loc = b.location || 'Unknown';
        if (!locationData[loc]) locationData[loc] = { demos: 0, revenue: 0 };
        locationData[loc].demos++;
        locationData[loc].revenue += 30;
      });
    });

    // Popular time slots
    const timeData = { '11:00 AM': 0, '3:00 PM': 0 };
    notRefunded.forEach(s => {
      const bookings = extractBookings(s);
      bookings.forEach(b => {
        if (timeData[b.time] !== undefined) timeData[b.time]++;
        else timeData[b.time] = 1;
      });
    });

    // Popular days of week
    const dayData = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    notRefunded.forEach(s => {
      const bookings = extractBookings(s);
      bookings.forEach(b => {
        if (b.date) {
          const d = new Date(b.date);
          const dayName = dayNames[d.getDay()];
          if (dayData[dayName] !== undefined) dayData[dayName]++;
        }
      });
    });

    // Customer insights
    const customers = {};
    paid.forEach(s => {
      const email = s.customer_email;
      const refunded = s.payment_intent?.charges?.data?.[0]?.refunded || false;
      if (!customers[email]) {
        customers[email] = {
          name: s.metadata.customerName,
          email: email,
          company: s.metadata.company,
          bookings: 0,
          totalSpent: 0,
          firstBooking: s.created,
          lastBooking: s.created,
          products: new Set(),
        };
      }
      const bookings = extractBookings(s);
      customers[email].bookings += bookings.length;
      if (!refunded) customers[email].totalSpent += s.amount_total / 100;
      if (s.created < customers[email].firstBooking) customers[email].firstBooking = s.created;
      if (s.created > customers[email].lastBooking) customers[email].lastBooking = s.created;
      if (s.metadata.product) customers[email].products.add(s.metadata.product);
      // Update name/company to latest
      customers[email].name = s.metadata.customerName;
      customers[email].company = s.metadata.company;
    });

    const customerList = Object.values(customers).map(c => ({
      ...c,
      products: Array.from(c.products),
      firstBooking: new Date(c.firstBooking * 1000).toISOString(),
      lastBooking: new Date(c.lastBooking * 1000).toISOString(),
      isRepeat: c.bookings > 1,
    })).sort((a, b) => b.bookings - a.bookings);

    res.json({
      monthly: monthlyData,
      locations: locationData,
      timeSlots: timeData,
      popularDays: dayData,
      customers: customerList,
      totalCustomers: customerList.length,
      repeatCustomers: customerList.filter(c => c.isRepeat).length,
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/bookings/:sessionId/refund - Cancel & refund a booking
app.post('/api/admin/bookings/:sessionId/refund', adminAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });

    if (!session.payment_intent) {
      return res.status(400).json({ error: 'No payment intent found for this session' });
    }

    const paymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent.id;

    // Check if already refunded
    const charges = session.payment_intent?.charges?.data;
    if (charges && charges[0]?.refunded) {
      return res.status(400).json({ error: 'This booking has already been refunded' });
    }

    // Create full refund
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
    });

    // Send cancellation email
    try {
      const bookings = extractBookings(session);
      await resend.emails.send({
        from: 'Woodlands Market <bookings@woodlandsmarket.com>',
        to: [session.customer_email],
        subject: 'Demo Booking Cancelled - Refund Issued',
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <div style="width: 60px; height: 60px; background: #fee2e2; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; font-size: 28px;">✕</div>
              <h1 style="color: #1a3a21; margin: 0 0 8px;">Booking Cancelled</h1>
              <p style="color: #7a6352;">Your demo booking has been cancelled and a full refund has been issued.</p>
            </div>
            <div style="background: #faf8f5; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
              <p style="margin: 0;"><strong>Company:</strong> ${session.metadata.company}</p>
              <p style="margin: 8px 0 0;"><strong>Refund Amount:</strong> $${(session.amount_total / 100).toFixed(2)}</p>
              <p style="margin: 8px 0 0;"><strong>Refund ID:</strong> ${refund.id}</p>
            </div>
            <p style="color: #7a6352; font-size: 14px;">Refunds typically appear on your statement within 5-10 business days.</p>
            <div style="text-align: center; margin-top: 32px; padding-top: 24px; border-top: 1px solid #e8e0d5; color: #7a6352; font-size: 14px;">
              <p><strong>Woodlands Market</strong></p>
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      console.error('Error sending cancellation email:', emailError);
    }

    res.json({
      success: true,
      refundId: refund.id,
      amount: (refund.amount / 100).toFixed(2),
    });
  } catch (error) {
    console.error('Error refunding booking:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/auth - Verify admin password
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
