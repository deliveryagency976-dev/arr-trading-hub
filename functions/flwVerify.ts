// ARR Trading Hub — Payment Verification & Status Check
// Called by frontend after payment to confirm status
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tx_ref, flw_transaction_id } = body;

    if (!tx_ref && !flw_transaction_id) {
      return Response.json({ error: 'tx_ref or flw_transaction_id required' }, { status: 400, headers: corsHeaders });
    }

    const FLW_SECRET_KEY = Deno.env.get('FLW_SECRET_KEY') || '';
    const base44 = createClientFromRequest(req);

    // ── Check our database first ──
    let dbTx = null;
    if (tx_ref) {
      const results = await base44.asServiceRole.entities.Transaction.filter({ tx_ref });
      dbTx = results?.[0] || null;
    }

    // ── If we have a Flutterwave transaction ID, verify with their API ──
    if (flw_transaction_id) {
      const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${flw_transaction_id}/verify`, {
        headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` },
      });
      const verifyData = await verifyRes.json();

      if (verifyData.status === 'success') {
        const flwStatus = verifyData.data?.status;
        const flwAmount = verifyData.data?.amount;
        const flwRef = verifyData.data?.tx_ref;

        // Update our DB record if found
        if (dbTx) {
          await base44.asServiceRole.entities.Transaction.update(dbTx.id, {
            flw_transaction_id: String(flw_transaction_id),
            status: flwStatus,
            charged_amount: verifyData.data?.charged_amount,
            flw_fee: verifyData.data?.app_fee,
            payment_method: verifyData.data?.payment_type,
            webhook_verified: flwStatus === 'successful',
            duplicate_checked: true,
            raw_flw_response: JSON.stringify(verifyData.data).slice(0, 2000),
          });
        } else if (flwStatus === 'successful') {
          // Create record if missing
          await base44.asServiceRole.entities.Transaction.create({
            tx_ref: flwRef || tx_ref,
            flw_transaction_id: String(flw_transaction_id),
            amount: flwAmount,
            charged_amount: verifyData.data?.charged_amount,
            flw_fee: verifyData.data?.app_fee,
            currency: verifyData.data?.currency || 'USD',
            status: flwStatus,
            customer_name: verifyData.data?.customer?.name || '',
            customer_email: verifyData.data?.customer?.email || '',
            customer_phone: verifyData.data?.customer?.phone_number || '',
            payment_method: verifyData.data?.payment_type || 'card',
            webhook_verified: true,
            duplicate_checked: true,
            raw_flw_response: JSON.stringify(verifyData.data).slice(0, 2000),
          });
        }

        return Response.json({
          status: flwStatus,
          tx_ref: flwRef || tx_ref,
          amount: flwAmount,
          currency: verifyData.data?.currency,
          payment_method: verifyData.data?.payment_type,
          customer: verifyData.data?.customer,
          charged_amount: verifyData.data?.charged_amount,
          flw_ref: verifyData.data?.flw_ref,
          verified: flwStatus === 'successful',
          message: flwStatus === 'successful' ? 'Payment confirmed ✅' : `Payment ${flwStatus}`,
        }, { headers: corsHeaders });
      }
    }

    // Return DB status only
    if (dbTx) {
      return Response.json({
        status: dbTx.status,
        tx_ref: dbTx.tx_ref,
        amount: dbTx.amount,
        currency: dbTx.currency,
        verified: dbTx.webhook_verified,
        message: dbTx.status === 'successful' ? 'Payment confirmed ✅' : `Payment ${dbTx.status}`,
      }, { headers: corsHeaders });
    }

    return Response.json({ status: 'not_found', message: 'Transaction not found' }, { status: 404, headers: corsHeaders });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
});
