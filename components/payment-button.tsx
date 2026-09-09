"use client";

import { useState } from "react";
import Script from "next/script";

declare global {
  interface Window {
    Razorpay: any;
  }
}

type PaymentButtonProps = {
  baseAmount: number;
  customerId?: string;
  callId?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
};

export default function PaymentButton({
  baseAmount,
  customerId,
  callId,
  customerName,
  customerEmail,
  customerPhone,
}: PaymentButtonProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const handlePayment = async () => {
    try {
      setLoading(true);
      setMessage("");

      /*
       * Step 1:
       * Ask our backend to create the Razorpay order.
       */
      const response = await fetch(
        "/api/payments/create-order",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            baseAmount,
            customerId,
            callId,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.message ||
            "Failed to create payment order"
        );
      }

      /*
       * Step 2:
       * Open Razorpay Checkout.
       */
      if (!window.Razorpay) {
        throw new Error(
          "Razorpay Checkout is not loaded yet. Please try again."
        );
      }

      const options = {
        key: data.razorpayKeyId,

        amount: data.order.amount,

        currency: data.order.currency,

        name: "Manual Calling CRM",

        description:
          "CRM Service Payment",

        order_id: data.order.id,

        prefill: {
          name: customerName || "",
          email: customerEmail || "",
          contact: customerPhone || "",
        },

        notes: {
          customerId: customerId || "",
          callId: callId || "",
        },

        theme: {
          color: "#2563eb",
        },

        handler: async function (
          paymentResponse: {
            razorpay_payment_id: string;
            razorpay_order_id: string;
            razorpay_signature: string;
          }
        ) {
          try {
            setMessage(
              "Payment completed. Verifying..."
            );

            /*
             * Step 3:
             * Send Razorpay's response to our server.
             *
             * The server will verify the signature.
             */
            const verifyResponse =
              await fetch(
                "/api/payments/verify",
                {
                  method: "POST",
                  headers: {
                    "Content-Type":
                      "application/json",
                  },
                  body: JSON.stringify({
                    razorpay_payment_id:
                      paymentResponse.razorpay_payment_id,

                    razorpay_order_id:
                      paymentResponse.razorpay_order_id,

                    razorpay_signature:
                      paymentResponse.razorpay_signature,
                  }),
                }
              );

            const verifyData =
              await verifyResponse.json();

            if (
              !verifyResponse.ok ||
              !verifyData.success
            ) {
              throw new Error(
                verifyData.message ||
                  "Payment verification failed"
              );
            }

            setMessage(
              "Payment successful and verified!"
            );
          } catch (error) {
            console.error(
              "Payment verification error:",
              error
            );

            setMessage(
              error instanceof Error
                ? error.message
                : "Payment verification failed"
            );
          }
        },

        modal: {
          confirm_close: true,
        },
      };

      const razorpay =
        new window.Razorpay(options);

      razorpay.on(
        "payment.failed",
        function (response: any) {
          console.error(
            "Razorpay payment failed:",
            response
          );

          setMessage(
            response?.error?.description ||
              "Payment failed"
          );
        }
      );

      razorpay.open();
    } catch (error) {
      console.error(
        "Payment error:",
        error
      );

      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to start payment"
      );
    } finally {
      setLoading(false);
    }
  };

  const totalAmount =
    baseAmount * 1.25;

  return (
    <>
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="afterInteractive"
      />

      <div className="space-y-3">
        <div className="rounded-lg border p-4">
          <div className="flex justify-between">
            <span>
              Base Amount
            </span>

            <span>
              ₹{baseAmount.toFixed(2)}
            </span>
          </div>

          <div className="flex justify-between">
            <span>
              Additional 25%
            </span>

            <span>
              ₹{(baseAmount * 0.25).toFixed(2)}
            </span>
          </div>

          <div className="mt-2 border-t pt-2">
            <div className="flex justify-between font-bold">
              <span>
                Total
              </span>

              <span>
                ₹{totalAmount.toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handlePayment}
          disabled={loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading
            ? "Processing..."
            : `Pay ₹${totalAmount.toFixed(2)}`}
        </button>

        {message && (
          <div className="rounded-lg border p-3 text-sm">
            {message}
          </div>
        )}
      </div>
    </>
  );
}