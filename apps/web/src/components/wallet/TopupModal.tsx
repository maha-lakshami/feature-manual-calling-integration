import React, { useState, useRef, useCallback, useEffect } from 'react';
import { X, CreditCard, CheckCircle2, AlertCircle, Loader2, Sparkles, ShieldCheck, Clock } from 'lucide-react';
import { api } from '../../api/client';

interface TopupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const PRESET_AMOUNTS = [
  { label: '₹100', paise: '10000', rupees: 100 },
  { label: '₹500', paise: '50000', rupees: 500 },
  { label: '₹1,000', paise: '100000', rupees: 1000 },
  { label: '₹5,000', paise: '500000', rupees: 5000 },
];

/* ── Razorpay Checkout script loader ─────────────────────────────────────── */

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

/**
 * Dynamically load checkout.js once. Subsequent calls return the cached
 * promise so the script is never appended twice.
 */
let checkoutPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (checkoutPromise) return checkoutPromise;

  checkoutPromise = new Promise<void>((resolve, reject) => {
    // Already loaded (e.g. by a previous session in the same SPA lifecycle).
    if (typeof (window as any).Razorpay === 'function') {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutPromise = null; // allow retry on next open
      reject(new Error('Failed to load Razorpay Checkout. Check your network connection.'));
    };
    document.head.appendChild(script);
  });

  return checkoutPromise;
}

/* ── Modal ────────────────────────────────────────────────────────────────── */

type ModalStep = 'select' | 'processing' | 'capture_ready' | 'verifying' | 'pending' | 'success';

export const TopupModal: React.FC<TopupModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [selectedPaise, setSelectedPaise] = useState<string>('50000');
  const [customRupees, setCustomRupees] = useState<string>('');
  const [step, setStep] = useState<ModalStep>('select');
  const [orderData, setOrderData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Track whether the Razorpay Checkout modal is currently open so we don't
  // allow closing the parent modal while it is active.
  const checkoutOpenRef = useRef(false);

  // Reset state when modal is opened fresh
  useEffect(() => {
    if (isOpen) {
      setStep('select');
      setOrderData(null);
      setError(null);
      setIsSubmitting(false);
      setCustomRupees('');
      setSelectedPaise('50000');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentPaise = customRupees ? (parseInt(customRupees, 10) * 100).toString() : selectedPaise;
  const currentRupees = parseInt(currentPaise, 10) / 100;

  /* ── Create order ──────────────────────────────────────────────────────── */

  const handleCreateOrder = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await api.topups.create(currentPaise);
      setOrderData(res);

      if (res.mock) {
        // Mock mode: show the existing simulation UI
        setStep('capture_ready');
      } else {
        // Live mode: open Razorpay Checkout
        await openRazorpayCheckout(res);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create top-up order');
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ── Razorpay Checkout (live mode) ─────────────────────────────────────── */

  const openRazorpayCheckout = async (order: any) => {
    try {
      setStep('processing');
      await loadCheckoutScript();
    } catch (loadErr: any) {
      setError(loadErr.message || 'Could not load Razorpay Checkout');
      setStep('select');
      return;
    }

    const RazorpayConstructor = (window as any).Razorpay;
    if (!RazorpayConstructor) {
      setError('Razorpay Checkout is not available. Please refresh and try again.');
      setStep('select');
      return;
    }

    const options = {
      key: order.keyId,
      order_id: order.razorpayOrderId,
      amount: order.amount?.paise ? Number(order.amount.paise) : undefined,
      currency: order.currency || 'INR',
      name: 'AiConnect',
      description: `Wallet Top-Up ${order.amount?.formatted || ''}`,
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        checkoutOpenRef.current = false;
        await handleCheckoutSuccess(order.orderId, response);
      },
      modal: {
        ondismiss: () => {
          checkoutOpenRef.current = false;
          setError('Payment was not completed. You can try again.');
          setStep('select');
        },
        escape: true,
        confirm_close: true,
      },
      theme: {
        color: '#004e9f',
      },
    };

    const rzp = new RazorpayConstructor(options);
    rzp.on('payment.failed', (response: any) => {
      checkoutOpenRef.current = false;
      const desc =
        response?.error?.description ||
        response?.error?.reason ||
        'Payment failed. Please try again.';
      setError(desc);
      setStep('select');
    });

    checkoutOpenRef.current = true;
    rzp.open();
  };

  /* ── Verify checkout callback ──────────────────────────────────────────── */

  const handleCheckoutSuccess = async (
    orderId: string,
    response: {
      razorpay_payment_id: string;
      razorpay_order_id: string;
      razorpay_signature: string;
    },
  ) => {
    setStep('verifying');
    setError(null);
    try {
      const result = await api.topups.verify(orderId, {
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
      });

      if (result.status === 'credited' || result.status === 'already_credited') {
        setStep('success');
        setTimeout(() => {
          onSuccess();
        }, 1500);
      } else if (result.status === 'pending') {
        setStep('pending');
      } else {
        setError('Unexpected verification result. Your wallet will be updated shortly.');
        setStep('pending');
      }
    } catch (err: any) {
      setError(err.message || 'Payment verification failed. Your wallet will be updated when Razorpay confirms the payment.');
      setStep('pending');
    }
  };

  /* ── Mock capture (mock mode) ──────────────────────────────────────────── */

  const handleSimulateCapture = async () => {
    if (!orderData?.orderId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await api.topups.mockCapture(orderData.orderId);
      setStep('success');
      setTimeout(() => {
        onSuccess();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Payment simulation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'var(--action-green-light)',
                border: '1px solid var(--action-green-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CreditCard size={20} color="#166534" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Top Up Wallet Credits</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Razorpay Instant Payment Gateway</div>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={checkoutOpenRef.current}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-rose-light)',
              border: '1px solid var(--accent-rose-border)',
              color: '#9f1239',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '18px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Amount selection */}
        {step === 'select' && (
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '10px' }}>
              Select Amount (INR)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '18px' }}>
              {PRESET_AMOUNTS.map((preset) => {
                const isSelected = selectedPaise === preset.paise && !customRupees;
                return (
                  <button
                    key={preset.paise}
                    type="button"
                    onClick={() => {
                      setSelectedPaise(preset.paise);
                      setCustomRupees('');
                    }}
                    style={{
                      padding: '16px',
                      borderRadius: 'var(--radius-md)',
                      background: isSelected ? '#eff6ff' : '#f8fafc',
                      border: isSelected ? '2px solid #004e9f' : '1px solid var(--border-subtle)',
                      color: isSelected ? '#004e9f' : 'var(--text-primary)',
                      fontWeight: 800,
                      fontSize: '1.05rem',
                      fontFamily: 'var(--font-mono)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      transition: 'all 0.1s ease',
                    }}
                  >
                    <span>{preset.label}</span>
                    {preset.rupees >= 1000 && <Sparkles size={14} color="#004e9f" />}
                  </button>
                );
              })}
            </div>

            <div style={{ marginBottom: '22px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                Or Custom Amount (₹)
              </label>
              <input
                type="number"
                min="1"
                max="500000"
                placeholder="e.g. 2500"
                value={customRupees}
                onChange={(e) => setCustomRupees(e.target.value)}
                className="input-field"
              />
            </div>

            <button
              onClick={handleCreateOrder}
              disabled={isSubmitting || currentRupees <= 0}
              className="btn btn-emerald btn-lg"
              style={{ width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Creating Razorpay Order...
                </>
              ) : (
                `Proceed to Pay ₹${currentRupees.toLocaleString('en-IN')}`
              )}
            </button>
          </div>
        )}

        {/* Step 2a: Processing — loading checkout script */}
        {step === 'processing' && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Loader2 size={36} className="animate-spin" style={{ color: '#004e9f', margin: '0 auto 16px auto', display: 'block' }} />
            <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '6px' }}>Opening Razorpay Checkout...</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Please complete the payment in the Razorpay window.
            </p>
          </div>
        )}

        {/* Step 2b: Simulated Razorpay Checkout (mock mode only) */}
        {step === 'capture_ready' && (
          <div>
            <div
              style={{
                padding: '18px',
                borderRadius: 'var(--radius-md)',
                background: '#f8fafc',
                border: '1px solid #bfdbfe',
                marginBottom: '20px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Order ID:</span>
                <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: '#004e9f', fontWeight: 600 }}>
                  {orderData?.razorpayOrderId}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Payable Amount:</span>
                <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#166534', fontFamily: 'var(--font-mono)' }}>
                  ₹{currentRupees.toLocaleString('en-IN')}.00
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Payment Mode:</span>
                <span className="badge badge-indigo">Mock Razorpay (UPI Simulation)</span>
              </div>
            </div>

            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '22px', lineHeight: 1.5 }}>
              Clicking below sends an authentic Razorpay HMAC-signed webhook payload through BullMQ to credit the wallet immediately.
            </p>

            <button
              onClick={handleSimulateCapture}
              disabled={isSubmitting}
              className="btn btn-emerald btn-lg"
              style={{ width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Verifying Webhook & Crediting...
                </>
              ) : (
                `Simulate Payment Capture (₹${currentRupees.toLocaleString('en-IN')})`
              )}
            </button>
          </div>
        )}

        {/* Step 3a: Verifying payment */}
        {step === 'verifying' && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Loader2 size={36} className="animate-spin" style={{ color: '#004e9f', margin: '0 auto 16px auto', display: 'block' }} />
            <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '6px' }}>Verifying Payment...</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Confirming payment with Razorpay and crediting your wallet.
            </p>
          </div>
        )}

        {/* Step 3b: Payment pending — webhook will settle */}
        {step === 'pending' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div
              style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                background: '#fef3c7',
                border: '1px solid #fbbf24',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              <Clock size={30} color="#d97706" />
            </div>
            <h3 style={{ fontSize: '1.15rem', color: 'var(--text-primary)', marginBottom: '8px' }}>Payment Received — Confirming</h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '20px' }}>
              Your payment is being confirmed with Razorpay. Your wallet will be credited shortly.
              You can safely close this dialog.
            </p>
            <button
              onClick={() => {
                onSuccess();
              }}
              className="btn btn-secondary"
              style={{ width: '100%' }}
            >
              Close & Refresh Wallet
            </button>
          </div>
        )}

        {/* Step 4: Success */}
        {step === 'success' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div
              style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                background: 'var(--action-green-light)',
                border: '1px solid var(--action-green-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              <CheckCircle2 size={34} color="#166534" />
            </div>
            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', marginBottom: '6px' }}>Top-up Successful!</h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              ₹{currentRupees.toLocaleString('en-IN')}.00 has been credited to your wallet balance.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
