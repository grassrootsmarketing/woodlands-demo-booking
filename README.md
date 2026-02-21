# Woodlands Market Demo Booking System

A complete booking system with Stripe payments and email confirmations.

## Setup Instructions

### 1. Get Your API Keys

You'll need:
- **Stripe Secret Key** (`sk_live_...`) - from [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
- **Resend API Key** (`re_...`) - you already have this

### 2. Deploy to Railway (Recommended - Free)

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub and create a new repo, or upload this code
4. Once deployed, click on your service → **"Variables"** tab
5. Add these environment variables:

```
STRIPE_SECRET_KEY=sk_live_your_secret_key_here
STRIPE_PUBLISHABLE_KEY=pk_live_51MA5mMJ9aYEf28ilOLjw7Sz9u3wy94m7fWDGNLZWAOkPSf5X85xDblBxOnA6mCClnlQkC3e7V6XfzvQ6pHueUora00qGkwzz8t
RESEND_API_KEY=re_TXuPwp3s_BxM5CGzdt1ZLaCZVAq4M3zSz
FRONTEND_URL=https://your-app-name.up.railway.app
```

6. Railway will auto-deploy. Copy your app URL and update `FRONTEND_URL`

### 3. Alternative: Deploy to Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run `vercel` in this directory
3. Add environment variables in Vercel dashboard
4. Update `FRONTEND_URL` to your Vercel URL

## Local Development

1. Copy `.env.example` to `.env`
2. Add your secret keys to `.env`
3. Run:
```bash
npm install
npm start
```
4. Open http://localhost:3000

## How It Works

1. Customer selects demo slots and fills out their info
2. Click "Pay & Confirm" → redirects to Stripe Checkout
3. After payment → redirects to success page
4. Email confirmation sent automatically with calendar attachment
5. 80% goes to Woodlands Market, 20% platform fee (configure in Stripe Dashboard)

## Setting Up the 80/20 Split

In Stripe Dashboard:
1. Go to **Connect** → **Settings**
2. Set up your platform for marketplace payments
3. Or manually transfer 80% to Woodlands Market's connected account

## Files

- `server.js` - Backend API (Stripe + Resend)
- `public/index.html` - Booking interface
- `public/success.html` - Post-payment confirmation page

## Support

Questions? Contact the developer.
