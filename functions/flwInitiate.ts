// ARR Trading Hub — Flutterwave Payment Initiator
// Creates a transaction record and returns a secure payment token
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  // Allow CORS for frontend
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      amount, currency = 'USD',
      customer_name, customer_email, customer_phone,
      destination_country, destination_currency,
      recipient_name, payment_method,
    } = body;

    // Validate required fields
    if (!amount || !customer_email || !customer_name) {
      return Response.json({ error: 'Missing required fields: amount, customer_email, customer_name' }, { status: 400, headers: corsHeaders });
    }
    if (amount < 10) {
      return Response.json({ error: 'Minimum transfer amount is $10' }, { status: 400, headers: corsHeaders });
    }

    const FLW_PUBLIC_KEY = Deno.env.get('FLW_PUBLIC_KEY') || '';
    const FLW_SECRET_KEY = Deno.env.get('FLW_SECRET_KEY') || '';

    // Generate unique tx_ref
    const tx_ref = `ARR-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const fee = parseFloat((amount * 0.015).toFixed(2));

    // Save transaction as pending in database (service role — no auth required for public checkout)
    const base44 = createClientFromRequest(req);
    const transaction = await base44.asServiceRole.entities.Transaction.create({
      tx_ref,
      amount,
      currency,
      status: 'pending',
      customer_name,
      customer_email,
      customer_phone: customer_phone || '',
      payment_method: payment_method || 'card',
      destination_country: destination_country || '',
      destination_currency: destination_currency || '',
      recipient_name: recipient_name || '',
      fee,
      webhook_verified: false,
      duplicate_checked: false,
      narration: `ARR Trading Hub — Send ${amount} ${currency} to ${destination_country || 'recipient'}`,
      ip_address: req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '',
    });

    // Initialize payment with Flutterwave Standard API
    const flwPayload = {
      tx_ref,
      amount,
      currency,
      redirect_url: `https://app.base44.com/superagent/6a0c7d676fee8af5174c66b8/payment-callback`,
      customer: {
        email: customer_email,
        phone_number: customer_phone || '',
        name: customer_name,
      },
      customizations: {
        title: 'ARR Trading Hub',
        description: `Send ${amount} ${currency} to ${destination_country || 'recipient'}`,
        logo: 'https://media.base44.com/images/public/6a0c7d676fee8af5174c66b8/00cfc2d5e_generated_image.png',
      },
      payment_options: 'card,banktransfer,ussd,barter',
      meta: {
        source: 'arr_trading_hub',
        destination_country,
        destination_currency,
        recipient_name,
        transaction_db_id: transaction.id,
      },
    };

    const flwRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(flwPayload),
    });

    const flwData = await flwRes.json();

    if (flwData.status === 'success') {
      return Response.json({
        status: 'success',
        tx_ref,
        payment_link: flwData.data?.link,
        transaction_id: transaction.id,
        amount,
        fee,
        public_key: FLW_PUBLIC_KEY,
      }, { headers: corsHeaders });
    } else {
      // Update transaction as failed
      await base44.asServiceRole.entities.Transaction.update(transaction.id, { status: 'failed' });
      return Response.json({ error: 'Payment initialization failed', details: flwData.message }, { status: 502, headers: corsHeaders });
    }

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
});
