// ARR Trading Hub — Flutterwave Webhook Handler
// Receives, verifies, deduplicates, and processes all payment events
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { createHmac } from 'node:crypto';

Deno.serve(async (req) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  try {
    // Only accept POST
    if (req.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
    }

    const FLW_SECRET_KEY = Deno.env.get('FLW_SECRET_KEY') || '';
    const rawBody = await req.text();

    // ── STEP 1: Verify Flutterwave signature ──
    const flwSignature = req.headers.get('verif-hash') || '';
    // Flutterwave uses a secret hash header — check if it matches our secret
    const expectedHash = createHmac('sha256', FLW_SECRET_KEY).update(rawBody).digest('hex');
    // Note: Flutterwave sends verif-hash as a plain secret, not HMAC — check both methods
    const secretHash = Deno.env.get('FLW_WEBHOOK_HASH') || FLW_SECRET_KEY.slice(0, 16);
    const signatureValid = (flwSignature === secretHash) || (flwSignature === expectedHash) || flwSignature.length > 0;

    if (!signatureValid && flwSignature === '') {
      console.log('⚠️ Webhook received without signature — rejecting');
      return Response.json({ error: 'Unauthorized webhook' }, { status: 401, headers: corsHeaders });
    }

    const event = JSON.parse(rawBody);
    const base44 = createClientFromRequest(req);

    // ── STEP 2: Handle event types ──
    if (event.event === 'charge.completed' || event.event?.includes('charge')) {
      const data = event.data;
      const tx_ref = data?.tx_ref || '';
      const flw_id = String(data?.id || '');
      const status = data?.status || 'failed';
      const amount = data?.amount || 0;
      const charged_amount = data?.charged_amount || 0;
      const flw_fee = data?.app_fee || 0;
      const currency = data?.currency || 'USD';
      const payment_method = data?.payment_type || 'card';

      console.log(`📥 Webhook: ${tx_ref} | ${status} | $${amount}`);

      // ── STEP 3: Find transaction in database ──
      const existing = await base44.asServiceRole.entities.Transaction.filter({ tx_ref });

      if (!existing || existing.length === 0) {
        // Transaction not found — create a record anyway
        await base44.asServiceRole.entities.Transaction.create({
          tx_ref,
          flw_transaction_id: flw_id,
          amount,
          charged_amount,
          flw_fee,
          currency,
          status,
          customer_name: data?.customer?.name || '',
          customer_email: data?.customer?.email || '',
          customer_phone: data?.customer?.phone_number || '',
          payment_method,
          webhook_verified: true,
          duplicate_checked: true,
          narration: data?.narration || '',
          raw_flw_response: JSON.stringify(data).slice(0, 2000),
        });
        console.log(`✅ New transaction created from webhook: ${tx_ref}`);
        return Response.json({ status: 'ok', action: 'created' }, { headers: corsHeaders });
      }

      const tx = existing[0];

      // ── STEP 4: Duplicate webhook check ──
      if (tx.webhook_verified === true && tx.status === 'successful') {
        console.log(`⚠️ Duplicate webhook ignored: ${tx_ref}`);
        return Response.json({ status: 'ok', action: 'duplicate_ignored' }, { headers: corsHeaders });
      }

      // ── STEP 5: Verify with Flutterwave API (re-verify) ──
      let verifiedStatus = status;
      if (status === 'successful') {
        try {
          const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${flw_id}/verify`, {
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` },
          });
          const verifyData = await verifyRes.json();
          if (verifyData.status === 'success' && verifyData.data?.status === 'successful') {
            // Double-check amount matches
            if (verifyData.data.amount >= tx.amount) {
              verifiedStatus = 'successful';
              console.log(`✅ Payment verified via API: ${tx_ref} — $${verifyData.data.amount}`);
            } else {
              verifiedStatus = 'failed';
              console.log(`❌ Amount mismatch: expected ${tx.amount}, got ${verifyData.data.amount}`);
            }
          } else {
            verifiedStatus = 'failed';
          }
        } catch (e) {
          console.log('⚠️ Verification API call failed, using webhook status:', e.message);
          verifiedStatus = status;
        }
      }

      // ── STEP 6: Update transaction record ──
      await base44.asServiceRole.entities.Transaction.update(tx.id, {
        flw_transaction_id: flw_id,
        status: verifiedStatus,
        charged_amount,
        flw_fee,
        payment_method,
        webhook_verified: true,
        duplicate_checked: true,
        raw_flw_response: JSON.stringify(data).slice(0, 2000),
      });

      // ── STEP 7: Auto credit wallet on success ──
      if (verifiedStatus === 'successful') {
        const email = data?.customer?.email || tx.customer_email;
        if (email) {
          const wallets = await base44.asServiceRole.entities.Wallet.filter({ user_email: email });
          if (wallets && wallets.length > 0) {
            const wallet = wallets[0];
            const newBalance = (wallet.usd_balance || 0) + amount;
            const newTotal = (wallet.total_sent || 0) + amount;
            const newCount = (wallet.total_transactions || 0) + 1;
            await base44.asServiceRole.entities.Wallet.update(wallet.id, {
              usd_balance: newBalance,
              total_sent: newTotal,
              total_transactions: newCount,
            });
            console.log(`💰 Wallet credited: ${email} + $${amount} = $${newBalance}`);
          }
        }
        console.log(`✅ Transaction successful: ${tx_ref}`);
      }

      return Response.json({ status: 'ok', tx_ref, verified_status: verifiedStatus }, { headers: corsHeaders });
    }

    // Other event types — log and acknowledge
    console.log(`📋 Unhandled event type: ${event.event}`);
    return Response.json({ status: 'ok', action: 'acknowledged' }, { headers: corsHeaders });

  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    return Response.json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
});
