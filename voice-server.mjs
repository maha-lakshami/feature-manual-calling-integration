import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

const PORT = 3001;
const NEXTJS_URL = "http://localhost:3000";

// Current ngrok URL for PORT 3001
const PUBLIC_WS_URL =
  process.env.PLIVO_STREAM_WS_URL ||
  "wss://herbal-scanning-disjoin.ngrok-free.dev";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY in .env");
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

// TRANSCRIPTION ONLY
// Gemini will convert the real call audio to text.
// It will NOT talk to the customer.
const MODEL = "gemini-3.5-transcribe-live";

/* =========================================================
   SMALL DELAY HELPER
   ========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   FIND CRM CALL
   ========================================================= */

async function getCrmCallId(providerCallId) {
  if (!providerCallId) {
    return null;
  }

  // Plivo and Prisma may create/update records very close
  // to each other, so retry for a few seconds.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      console.log(
        `🔎 Looking for CRM call (${attempt}/10):`,
        providerCallId
      );

      const response = await fetch(
        `${NEXTJS_URL}/api/calls?providerCallId=${encodeURIComponent(
          providerCallId
        )}`
      );

      if (response.ok) {
        const data = await response.json();

        if (data.success) {
          const crmCallId = data.calls?.[0]?.id || null;

          if (crmCallId) {
            console.log(
              "✅ CRM Call ID found:",
              crmCallId
            );

            return crmCallId;
          }
        }
      } else {
        console.error(
          "❌ CRM call lookup failed:",
          response.status
        );
      }
    } catch (error) {
      console.error(
        "❌ CRM call lookup error:",
        error
      );
    }

    await sleep(500);
  }

  console.error(
    "❌ CRM Call ID not found:",
    providerCallId
  );

  return null;
}

/* =========================================================
   SAVE TRANSCRIPT
   ========================================================= */

async function saveTranscript(
  crmCallId,
  speaker,
  text
) {
  if (!crmCallId) {
    console.error(
      "❌ Cannot save transcript: CRM Call ID missing"
    );
    return;
  }

  if (
    speaker !== "customer" &&
    speaker !== "salesperson"
  ) {
    console.error(
      "❌ Invalid transcript speaker:",
      speaker
    );
    return;
  }

  if (
    typeof text !== "string" ||
    !text.trim()
  ) {
    return;
  }

  try {
    const cleanText = text.trim();

    const response = await fetch(
      `${NEXTJS_URL}/api/calls/${encodeURIComponent(
        crmCallId
      )}/transcript`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          speaker,
          text: cleanText,
          timestamp: new Date().toISOString(),
        }),
      }
    );

    const data = await response.json().catch(
      () => null
    );

    if (!response.ok || !data?.success) {
      console.error(
        "❌ Failed to save transcript:",
        data || response.status
      );

      return;
    }

    console.log(
      `📝 Transcript saved [${speaker}]: ${cleanText}`
    );
  } catch (error) {
    console.error(
      "❌ Transcript save error:",
      error
    );
  }
}

/* =========================================================
   CREATE SPEAKER TRANSCRIPTION SESSION
   ========================================================= */

async function createSpeakerTranscriber(
  label,
  crmCallId,
  speaker
) {
  console.log(
    `🤖 Starting Gemini transcription: ${label}`
  );

  const session = await ai.live.connect({
    model: MODEL,

    config: {
      // TEXT ONLY
      responseModalities: [Modality.TEXT],

      // Real speech-to-text
      inputAudioTranscription: {
        languageCodes: [],
        mode: "VERBATIM",
      },
    },

    callbacks: {
      onopen() {
        console.log(
          `🤖 Gemini transcription connected: ${label}`
        );
      },

      async onmessage(message) {
        try {
          const serverContent =
            message?.serverContent;

          if (!serverContent) {
            return;
          }

          const text =
            serverContent
              .inputTranscription
              ?.text
              ?.trim();

          if (!text) {
            return;
          }

          console.log(
            `🗣️ ${label}:`,
            text
          );

          // Save the REAL spoken words
          await saveTranscript(
            crmCallId,
            speaker,
            text
          );
        } catch (error) {
          console.error(
            `❌ Transcription callback error [${label}]:`,
            error
          );
        }
      },

      onerror(error) {
        console.error(
          `❌ Gemini transcription error [${label}]:`,
          error
        );
      },

      onclose(event) {
        console.log(
          `🔌 Gemini transcription closed [${label}]:`,
          event?.reason || "no reason"
        );
      },
    },
  });

  return session;
}

/* =========================================================
   HTTP SERVER
   ========================================================= */

const httpServer = http.createServer(
  async (req, res) => {
    try {
      console.log(
        "HTTP request:",
        req.method,
        req.url
      );

            /* =====================================================
         PLIVO ANSWER WEBHOOK

         Plivo reaches the public ngrok URL on port 3001.

         We forward the answer webhook to Next.js running
         on port 3000.

         Next.js will generate the actual Plivo <Dial> XML.
         ===================================================== */

      if (
        req.method === "POST" &&
        req.url?.startsWith("/api/calls/answer")
      ) {
        const chunks = [];

        req.on("data", (chunk) => {
          chunks.push(chunk);
        });

        req.on("end", async () => {
          try {
            const body = Buffer.concat(chunks);

            console.log("=================================");
            console.log("📞 Forwarding Plivo answer to Next.js");
            console.log("URL:", req.url);
            console.log("=================================");

            const response = await fetch(
              `${NEXTJS_URL}${req.url}`,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    req.headers["content-type"] ||
                    "application/x-www-form-urlencoded",
                },

                body,
              }
            );

            const responseText = await response.text();

            console.log(
              "✅ Next.js answer response:",
              response.status
            );

            res.writeHead(
              response.status,
              {
                "Content-Type":
                  response.headers.get("content-type") ||
                  "application/xml",
              }
            );

            res.end(responseText);
          } catch (error) {
            console.error(
              "❌ Failed to forward answer webhook:",
              error
            );

            if (!res.headersSent) {
              res.writeHead(500, {
                "Content-Type": "application/xml",
              });
            }

            res.end(
              `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Sorry, there was a technical problem.</Speak>
  <Hangup/>
</Response>`
            );
          }
        });

        return;
      }

      /* =====================================================
         PLIVO STATUS WEBHOOK
         ===================================================== */

      if (
        req.method === "POST" &&
        req.url === "/api/calls/status"
      ) {
        const chunks = [];

        req.on("data", (chunk) => {
          chunks.push(chunk);
        });

        req.on("end", async () => {
          try {
            const body =
              Buffer.concat(chunks);

            console.log(
              "================================="
            );

            console.log(
              "Forwarding Plivo status to Next.js"
            );

            console.log(
              "================================="
            );

            const response =
              await fetch(
                `${NEXTJS_URL}/api/calls/status`,
                {
                  method: "POST",

                  headers: {
                    "Content-Type":
                      req.headers[
                        "content-type"
                      ] ||
                      "application/x-www-form-urlencoded",
                  },

                  body,
                }
              );

            const responseText =
              await response.text();

            res.writeHead(
              response.status,
              {
                "Content-Type":
                  response.headers.get(
                    "content-type"
                  ) ||
                  "application/json",
              }
            );

            res.end(
              responseText
            );
          } catch (error) {
            console.error(
              "❌ Failed to forward status:",
              error
            );

            if (!res.headersSent) {
              res.writeHead(500, {
                "Content-Type":
                  "application/json",
              });
            }

            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Failed to forward status webhook",
              })
            );
          }
        });

        return;
      }



      /* =====================================================
         HEALTH CHECK
         ===================================================== */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(200, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            status: "ok",
            server: "voice-server",
            port: PORT,
            websocketUrl:
              PUBLIC_WS_URL,
            model: MODEL,
            mode:
              "transcription-only",
          })
        );

        return;
      }

      /* =====================================================
         NOT FOUND
         ===================================================== */

      res.writeHead(404, {
        "Content-Type":
          "application/json",
      });

      res.end(
        JSON.stringify({
          error: "Not found",
        })
      );
    } catch (error) {
      console.error(
        "❌ HTTP server error:",
        error
      );

      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type":
            "application/json",
        });
      }

      res.end(
        JSON.stringify({
          success: false,
          error:
            "Internal server error",
        })
      );
    }
  }
);

/* =========================================================
   WEBSOCKET SERVER
   ========================================================= */

const wss =
  new WebSocketServer({
    server: httpServer,
  });

console.log(
  `🎙️ Voice server starting on port ${PORT}`
);

console.log(
  `🌐 Public WebSocket URL: ${PUBLIC_WS_URL}`
);

console.log(
  `🧠 Gemini model: ${MODEL}`
);

console.log(
  "📝 Mode: REAL-TIME TRANSCRIPTION ONLY"
);

/* =========================================================
   PLIVO WEBSOCKET CONNECTION
   ========================================================= */

wss.on(
  "connection",
  async (plivoSocket) => {
    console.log(
      "================================="
    );

    console.log(
      "📞 Plivo WebSocket connected"
    );

    console.log(
      "================================="
    );

    let streamId = null;
    let providerCallId = null;
    let crmCallId = null;

    let customerSession = null;
    let salespersonSession = null;

    try {
      /* ===================================================
         PLIVO MESSAGES
         =================================================== */

      plivoSocket.on(
        "message",
        async (rawMessage) => {
          try {
            const message =
              JSON.parse(
                rawMessage.toString()
              );

            /* =============================================
               STREAM START
               ============================================= */

            if (
              message.event === "start"
            ) {
              streamId =
                message.start?.streamId;

              providerCallId =
                message.start?.callId;

              console.log(
                "🎬 Stream started"
              );

              console.log(
                "Stream ID:",
                streamId
              );

              console.log(
                "Plivo Call ID:",
                providerCallId
              );

              console.log(
                "Tracks:",
                message.start?.tracks
              );

              console.log(
                "Audio format:",
                message.start?.mediaFormat
              );

              /* =========================================
                 FIND CRM CALL
                 ========================================= */

              crmCallId =
                await getCrmCallId(
                  providerCallId
                );

              console.log(
                "CRM Call ID:",
                crmCallId
              );

              if (!crmCallId) {
                console.error(
                  "❌ CRM call not found."
                );

                return;
              }

              /* =========================================
                 CUSTOMER TRANSCRIPTION
                 ========================================= */

              customerSession =
                await createSpeakerTranscriber(
                  "Customer",
                  crmCallId,
                  "customer"
                );

              /* =========================================
                 SALESPERSON TRANSCRIPTION
                 ========================================= */

              salespersonSession =
                await createSpeakerTranscriber(
                  "Salesperson",
                  crmCallId,
                  "salesperson"
                );

              console.log(
                "================================="
              );

              console.log(
                "✅ Both transcription sessions ready"
              );

              console.log(
                "================================="
              );

              return;
            }

            /* =============================================
               AUDIO MEDIA
               ============================================= */

            if (
              message.event === "media"
            ) {
              const payload =
                message.media?.payload;

              const track =
                message.media?.track;

              if (!payload) {
                return;
              }

              if (!track) {
                console.warn(
                  "⚠️ Media message has no track"
                );

                return;
              }

              const mulawAudio =
                Buffer.from(
                  payload,
                  "base64"
                );

              const pcm16Audio =
                mulaw8kToPcm16k(
                  mulawAudio
                );

              const audioData =
                pcm16Audio.toString(
                  "base64"
                );

              /*
               * IMPORTANT:
               *
               * We DO NOT send anything back
               * to Plivo.
               *
               * This is transcription only.
               */

              if (
                track === "inbound" &&
                customerSession
              ) {
                customerSession.sendRealtimeInput(
                  {
                    audio: {
                      data:
                        audioData,

                      mimeType:
                        "audio/pcm;rate=16000",
                    },
                  }
                );

                return;
              }

              if (
                track === "outbound" &&
                salespersonSession
              ) {
                salespersonSession.sendRealtimeInput(
                  {
                    audio: {
                      data:
                        audioData,

                      mimeType:
                        "audio/pcm;rate=16000",
                    },
                  }
                );

                return;
              }

              console.warn(
                "⚠️ Unknown audio track:",
                track
              );

              return;
            }

            /* =============================================
               STREAM STOP
               ============================================= */

            if (
              message.event === "stop"
            ) {
              console.log(
                "🛑 Plivo stream stopped"
              );

              closeGeminiSession(
                customerSession,
                "Customer"
              );

              closeGeminiSession(
                salespersonSession,
                "Salesperson"
              );

              customerSession = null;
              salespersonSession =
                null;

              return;
            }

            console.log(
              "Plivo event:",
              message.event
            );
          } catch (error) {
            console.error(
              "❌ Plivo WebSocket message error:",
              error
            );
          }
        }
      );

      /* =================================================
         SOCKET CLOSE
         ================================================= */

      plivoSocket.on(
        "close",
        () => {
          console.log(
            "📴 Plivo WebSocket disconnected"
          );

          closeGeminiSession(
            customerSession,
            "Customer"
          );

          closeGeminiSession(
            salespersonSession,
            "Salesperson"
          );

          customerSession = null;
          salespersonSession =
            null;
        }
      );

      /* =================================================
         SOCKET ERROR
         ================================================= */

      plivoSocket.on(
        "error",
        (error) => {
          console.error(
            "❌ Plivo WebSocket error:",
            error
          );
        }
      );
    } catch (error) {
      console.error(
        "❌ Failed to initialize transcription:",
        error
      );

      closeGeminiSession(
        customerSession,
        "Customer"
      );

      closeGeminiSession(
        salespersonSession,
        "Salesperson"
      );

      if (
        plivoSocket.readyState ===
        plivoSocket.OPEN
      ) {
        plivoSocket.close();
      }
    }
  }
);

/* =========================================================
   CLOSE GEMINI SESSION
   ========================================================= */

function closeGeminiSession(
  session,
  label
) {
  if (!session) {
    return;
  }

  try {
    session.close();

    console.log(
      `🔌 Closed Gemini session: ${label}`
    );
  } catch (error) {
    console.error(
      `❌ Error closing Gemini session [${label}]:`,
      error
    );
  }
}

/* =========================================================
   AUDIO CONVERSION
   ========================================================= */

/*
 * Plivo:
 *
 * 8kHz μ-law
 *
 *        ↓
 *
 * 8kHz PCM16
 *
 *        ↓
 *
 * 16kHz PCM16
 */

function mulaw8kToPcm16k(
  buffer
) {
  if (
    !buffer ||
    buffer.length === 0
  ) {
    return Buffer.alloc(0);
  }

  const output =
    Buffer.alloc(
      buffer.length * 4
    );

  for (
    let i = 0;
    i < buffer.length;
    i++
  ) {
    const sample =
      mulawToLinear(
        buffer[i]
      );

    // Duplicate the 8kHz sample
    // to produce 16kHz PCM.
    output.writeInt16LE(
      sample,
      i * 4
    );

    output.writeInt16LE(
      sample,
      i * 4 + 2
    );
  }

  return output;
}

/* =========================================================
   μ-LAW → PCM16
   ========================================================= */

function mulawToLinear(
  value
) {
  value =
    (~value) & 0xff;

  const sign =
    value & 0x80;

  const exponent =
    (value >> 4) & 0x07;

  const mantissa =
    value & 0x0f;

  let sample =
    ((mantissa << 3) +
      0x84) <<
    exponent;

  sample -= 0x84;

  return sign
    ? -sample
    : sample;
}

/* =========================================================
   START SERVER
   ========================================================= */

httpServer.listen(
  PORT,
  () => {
    console.log(
      `🎙️ Voice server running on http://localhost:${PORT}`
    );

    console.log(
      `🔌 WebSocket server running on ws://localhost:${PORT}`
    );

    console.log(
      `❤️ Health: http://localhost:${PORT}/health`
    );
  }
);