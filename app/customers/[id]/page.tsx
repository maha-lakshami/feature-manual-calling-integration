"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import PaymentButton from "@/components/payment-button";
import {
  ArrowLeft,
  CalendarDays,
  Mail,
  Phone,
  User,
  UserRound,
} from "lucide-react";

type Customer = {
  id: string;
  name: string;
  phone: string;
  email?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
};

type Call = {
  id: string;
  customerId: string;
  salespersonId: string;
  provider: string;
  providerCallId?: string | null;
  status: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  manualNotes?: string | null;
  createdAt: string;
};

type AIAnalysis = {
  id: string;
  callId: string;
  summary: string;
  outcome: string;
  interest: string;
  requirement?: string | null;
  objection?: string | null;
  nextAction: string;
  followUpRequired: boolean;
  followUpDate?: string | null;
  followUpTime?: string | null;
  priority: string;
  reason: string;
  confidence: number;
  model: string;
  humanReviewed?: boolean;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  createdAt: string;
};

type FollowUpTask = {
  id: string;
  customerId: string;
  assignedTo?: string | null;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  priority: string;
  status: string;
  createdAt?: string;
};

export default function CustomerDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [customer, setCustomer] =
    useState<Customer | null>(null);

  const [calls, setCalls] = useState<Call[]>([]);

  const [loading, setLoading] = useState(true);

  const [callsLoading, setCallsLoading] =
    useState(true);

  const [error, setError] = useState("");

  const [calling, setCalling] =
    useState(false);

  const [callMessage, setCallMessage] =
    useState("");

  // --------------------------------------------------
  // MANUAL CALL NOTES
  // --------------------------------------------------

  const [selectedCallId, setSelectedCallId] =
    useState<string | null>(null);

  const [manualNotes, setManualNotes] =
    useState("");

  const [savingNotes, setSavingNotes] =
    useState(false);

  const [notesMessage, setNotesMessage] =
    useState("");

  // --------------------------------------------------
  // GEMINI ANALYSIS
  // --------------------------------------------------

  const [analyzingCall, setAnalyzingCall] =
    useState(false);

  const [analysisMessage, setAnalysisMessage] =
    useState("");

  const [aiAnalysis, setAiAnalysis] =
    useState<AIAnalysis | null>(null);

  const [reviewSaving, setReviewSaving] =
    useState(false);

  const [reviewMessage, setReviewMessage] =
    useState("");

  // --------------------------------------------------
  // FOLLOW-UP TASKS
  // --------------------------------------------------

  const [followUpTasks, setFollowUpTasks] =
    useState<FollowUpTask[]>([]);

  const [followUpLoading, setFollowUpLoading] =
    useState(false);

  const [followUpError, setFollowUpError] =
    useState("");

  // --------------------------------------------------
  // DATE HELPER
  // --------------------------------------------------

  function normalizeDateOnly(
    value?: string | null
  ): string | null {
    if (!value) {
      return null;
    }

    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    // Use local date to avoid UTC timezone shifting.
    const year = date.getFullYear();

    const month = String(
      date.getMonth() + 1
    ).padStart(2, "0");

    const day = String(
      date.getDate()
    ).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  // --------------------------------------------------
  // LOAD CUSTOMER + CALL HISTORY
  // --------------------------------------------------

  useEffect(() => {
    async function loadCustomer() {
      try {
        const { id } = await params;

        const customerResponse = await fetch(
          `/api/customers/${id}`,
          {
            cache: "no-store",
          }
        );

        const customerData =
          await customerResponse.json();

        if (!customerResponse.ok) {
          setError(
            customerData.message ||
              "Customer not found"
          );

          return;
        }

        setCustomer(
          customerData.customer
        );

        setCallsLoading(true);

        const callsResponse = await fetch(
          `/api/customers/${id}/calls`,
          {
            cache: "no-store",
          }
        );

        const callsData =
          await callsResponse.json();

        if (callsResponse.ok) {
          setCalls(
            callsData.calls || []
          );
        } else {
          console.error(
            "Failed to load call history:",
            callsData.message
          );

          setCalls([]);
        }

        await loadFollowUpTasks(id);
      } catch (err) {
        console.error(err);

        setError(
          "Failed to load customer"
        );
      } finally {
        setLoading(false);
        setCallsLoading(false);
      }
    }

    loadCustomer();
  }, [params]);

  // --------------------------------------------------
  // RELOAD CALL HISTORY
  // --------------------------------------------------

  async function loadCallHistory() {
    if (!customer) {
      return;
    }

    try {
      setCallsLoading(true);

      const response = await fetch(
        `/api/customers/${customer.id}/calls`,
        {
          cache: "no-store",
        }
      );

      const data =
        await response.json();

      if (response.ok) {
        setCalls(
          data.calls || []
        );
      } else {
        console.error(
          "Failed to reload call history:",
          data.message
        );
      }
    } catch (err) {
      console.error(
        "Call history loading error:",
        err
      );
    } finally {
      setCallsLoading(false);
    }
  }

  // --------------------------------------------------
  // LOAD FOLLOW-UP TASKS
  // --------------------------------------------------

  async function loadFollowUpTasks(
    customerId: string
  ) {
    try {
      setFollowUpLoading(true);
      setFollowUpError("");

      const response = await fetch(
        `/api/follow-ups?customerId=${encodeURIComponent(
          customerId
        )}`,
        {
          cache: "no-store",
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        if (response.status !== 404) {
          setFollowUpError(
            data.message ||
              "Failed to load follow-up tasks."
          );
        }

        setFollowUpTasks([]);
        return;
      }

      setFollowUpTasks(
        data.tasks ||
          data.followUps ||
          data.followUpTasks ||
          []
      );
    } catch (error) {
      console.error(
        "Follow-up loading error:",
        error
      );

      setFollowUpTasks([]);
    } finally {
      setFollowUpLoading(false);
    }
  }

  // --------------------------------------------------
  // HANDLE CALL
  // --------------------------------------------------

  async function handleCallCustomer() {
    if (!customer) {
      setError(
        "Customer information is not available."
      );

      return;
    }

    try {
      setCalling(true);
      setCallMessage("");

      const response = await fetch(
        "/api/calls",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            customerId:
              customer.id,

            salespersonId:
              customer.assignedTo ||
              "sales-001",
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            data.message ||
            "Failed to initiate call"
        );
      }

      setCallMessage(
        "Call initiated successfully. The customer's phone should ring shortly."
      );

      setTimeout(() => {
        loadCallHistory();
      }, 3000);
    } catch (err) {
      console.error(
        "Call error:",
        err
      );

      setCallMessage(
        err instanceof Error
          ? err.message
          : "Failed to initiate call."
      );
    } finally {
      setCalling(false);
    }
  }

  // --------------------------------------------------
  // SELECT CALL FOR NOTES
  // --------------------------------------------------

  function handleOpenNotes(call: Call) {
    setSelectedCallId(call.id);

    setManualNotes(
      call.manualNotes || ""
    );

    setNotesMessage("");

    setAiAnalysis(null);

    setAnalysisMessage("");

    setReviewMessage("");
  }

  // --------------------------------------------------
  // CLOSE NOTES
  // --------------------------------------------------

  function handleCloseNotes() {
    setSelectedCallId(null);
    setManualNotes("");
    setNotesMessage("");

    setAiAnalysis(null);

    setAnalysisMessage("");
    setReviewMessage("");
  }

  // --------------------------------------------------
  // SAVE MANUAL NOTES
  // --------------------------------------------------

  async function handleSaveNotes() {
    if (!selectedCallId) {
      return;
    }

    try {
      setSavingNotes(true);
      setNotesMessage("");

      const response = await fetch(
        `/api/calls/${selectedCallId}/notes`,
        {
          method: "PATCH",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            manualNotes,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Failed to save call notes"
        );
      }

      setNotesMessage(
        "Call notes saved successfully."
      );

      await loadCallHistory();
    } catch (error) {
      console.error(
        "Save notes error:",
        error
      );

      setNotesMessage(
        error instanceof Error
          ? error.message
          : "Failed to save call notes."
      );
    } finally {
      setSavingNotes(false);
    }
  }

  // --------------------------------------------------
  // ANALYZE CALL WITH GEMINI
  // --------------------------------------------------

  async function handleAnalyzeCall() {
    if (!selectedCallId) {
      return;
    }

    if (!manualNotes.trim()) {
      setAnalysisMessage(
        "Please save some manual notes before analyzing the call."
      );

      return;
    }

    try {
      setAnalyzingCall(true);
      setAnalysisMessage("");
      setReviewMessage("");
      setAiAnalysis(null);

      const response = await fetch(
        `/api/calls/${selectedCallId}/analyze`,
        {
          method: "POST",
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Failed to analyze call"
        );
      }

      setAiAnalysis(
        data.analysis
      );

      setAnalysisMessage(
        "Gemini analysis completed successfully."
      );
    } catch (error) {
      console.error(
        "Gemini analysis error:",
        error
      );

      setAnalysisMessage(
        error instanceof Error
          ? error.message
          : "Failed to analyze call."
      );
    } finally {
      setAnalyzingCall(false);
    }
  }

  // --------------------------------------------------
  // SAVE HUMAN REVIEW
  // --------------------------------------------------

  async function handleSaveHumanReview() {
    if (!selectedCallId || !aiAnalysis) {
      return;
    }

    try {
      setReviewSaving(true);
      setReviewMessage("");

      const followUpDate =
        normalizeDateOnly(
          aiAnalysis.followUpDate
        );

      const response = await fetch(
        `/api/calls/${selectedCallId}/review`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            summary: aiAnalysis.summary,

            outcome:
              aiAnalysis.outcome,

            interest:
              aiAnalysis.interest,

            requirement:
              aiAnalysis.requirement ||
              null,

            objection:
              aiAnalysis.objection ||
              null,

            nextAction:
              aiAnalysis.nextAction,

            followUpRequired:
              aiAnalysis.followUpRequired,

            followUpDate,

            followUpTime:
              aiAnalysis.followUpTime ||
              null,

            priority:
              aiAnalysis.priority,

            reason:
              aiAnalysis.reason,

            confidence:
              aiAnalysis.confidence,

            reviewedBy:
              customer?.assignedTo ||
              "sales-001",
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Failed to save human review"
        );
      }

      setAiAnalysis(data.analysis);

      if (customer) {
        await loadFollowUpTasks(
          customer.id
        );
      }

      if (data.followUpTask) {
        setFollowUpTasks(
          (currentTasks) => {
            const task =
              data.followUpTask as FollowUpTask;

            const existingIndex =
              currentTasks.findIndex(
                (item) =>
                  item.id === task.id
              );

            if (
              existingIndex === -1
            ) {
              return [
                task,
                ...currentTasks,
              ];
            }

            const updated = [
              ...currentTasks,
            ];

            updated[existingIndex] =
              task;

            return updated;
          }
        );
      }

      setReviewMessage(
        "Analysis reviewed and saved successfully."
      );
    } catch (error) {
      console.error(
        "Human review save error:",
        error
      );

      setReviewMessage(
        error instanceof Error
          ? error.message
          : "Failed to save human review."
      );
    } finally {
      setReviewSaving(false);
    }
  }

  // --------------------------------------------------
  // LOADING
  // --------------------------------------------------

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f8fa]">
        <p className="text-sm text-[#7c8697]">
          Loading customer...
        </p>
      </div>
    );
  }

  // --------------------------------------------------
  // ERROR
  // --------------------------------------------------

  if (error || !customer) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#f7f8fa]">
        <p className="text-lg font-semibold text-[#172033]">
          {error ||
            "Customer not found"}
        </p>

        <Link
          href="/customers"
          className="mt-4 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Back to Customers
        </Link>
      </div>
    );
  }

  // --------------------------------------------------
  // PAGE
  // --------------------------------------------------

  return (
    <div className="min-h-screen bg-[#f7f8fa] text-[#172033]">
      {/* HEADER */}

      <header className="flex h-[82px] items-center justify-between border-b border-[#e5e7eb] bg-white px-8">
        <div>
          <p className="text-sm text-[#8a93a3]">
            Sales Workspace
          </p>

          <h1 className="text-xl font-bold">
            Customer Details
          </h1>
        </div>

        <Link
          href="/customers"
          className="flex items-center gap-2 rounded-lg border border-[#dfe3e8] bg-white px-4 py-2.5 text-sm font-semibold text-[#4e596b] hover:bg-[#f5f6f8]"
        >
          <ArrowLeft size={17} />
          Back to Customers
        </Link>
      </header>

      {/* CONTENT */}

      <main className="mx-auto max-w-6xl p-8">
        {/* CUSTOMER HEADER CARD */}

        <div className="mb-6 rounded-2xl border border-[#e5e7eb] bg-white p-7 shadow-sm">
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
            <div className="flex items-center gap-5">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-50 text-2xl font-bold text-blue-600">
                {customer.name
                  .charAt(0)
                  .toUpperCase()}
              </div>

              <div>
                <h2 className="text-2xl font-bold">
                  {customer.name}
                </h2>

                <p className="mt-1 text-sm text-[#7c8697]">
                  Customer ID:{" "}
                  {customer.id}
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge
                    value={
                      customer.status ||
                      "New"
                    }
                  />

                  <PriorityBadge
                    value={
                      customer.priority ||
                      "MEDIUM"
                    }
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end">
              <button
                type="button"
                onClick={
                  handleCallCustomer
                }
                disabled={calling}
                className="flex items-center justify-center gap-2 rounded-xl bg-green-600 px-7 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Phone size={19} />

                {calling
                  ? "Calling..."
                  : "Call Customer"}
              </button>

              {callMessage && (
                <p className="mt-3 max-w-sm text-right text-sm text-[#596476]">
                  {callMessage}
                </p>
              )}

                 <div className="w-[280px]">
                  <PaymentButton
                  baseAmount={100}
                   customerId={customer.id}
                   customerName={customer.name}
                   customerEmail={customer.email}
                   customerPhone={customer.phone}
                  />
            </div>
          </div>
        </div>
        </div>

        {/* INFORMATION */}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* CONTACT INFORMATION */}

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h3 className="mb-6 text-lg font-bold">
              Contact Information
            </h3>

            <div className="space-y-5">
              <InfoRow
                icon={
                  <User size={19} />
                }
                label="Full Name"
                value={
                  customer.name
                }
              />

              <InfoRow
                icon={
                  <Phone size={19} />
                }
                label="Phone Number"
                value={
                  customer.phone
                }
              />

              <InfoRow
                icon={
                  <Mail size={19} />
                }
                label="Email Address"
                value={
                  customer.email ||
                  "Not provided"
                }
              />
            </div>
          </section>

          {/* CRM INFORMATION */}

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h3 className="mb-6 text-lg font-bold">
              CRM Information
            </h3>

            <div className="space-y-5">
              <InfoRow
                icon={
                  <UserRound
                    size={19}
                  />
                }
                label="Assigned To"
                value={
                  customer.assignedTo ||
                  "Not assigned"
                }
              />

              <InfoRow
                icon={
                  <CalendarDays
                    size={19}
                  />
                }
                label="Customer Since"
                value={
                  customer.createdAt
                    ? new Date(
                        customer.createdAt
                      ).toLocaleDateString()
                    : "—"
                }
              />

              <InfoRow
                icon={
                  <CalendarDays
                    size={19}
                  />
                }
                label="Last Updated"
                value={
                  customer.updatedAt
                    ? new Date(
                        customer.updatedAt
                      ).toLocaleDateString()
                    : "—"
                }
              />
            </div>
          </section>
        </div>

        {/* CALL HISTORY */}

        <section className="mt-6 rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold">
                Call History
              </h3>

              <p className="mt-1 text-sm text-[#8a93a3]">
                Previous calls with this customer.
              </p>
            </div>

            <button
              type="button"
              onClick={
                loadCallHistory
              }
              className="rounded-lg border border-[#dfe3e8] bg-white px-4 py-2 text-sm font-semibold text-[#4e596b] hover:bg-[#f5f6f8]"
            >
              Refresh
            </button>
          </div>

          {callsLoading ? (
            <div className="flex min-h-[140px] items-center justify-center rounded-xl border border-dashed border-[#dfe3e8] bg-[#fafbfc]">
              <p className="text-sm text-[#8a93a3]">
                Loading call history...
              </p>
            </div>
          ) : calls.length ===
            0 ? (
            <div className="flex min-h-[140px] items-center justify-center rounded-xl border border-dashed border-[#dfe3e8] bg-[#fafbfc]">
              <div className="text-center">
                <Phone
                  size={28}
                  className="mx-auto mb-2 text-[#aab2bf]"
                />

                <p className="text-sm font-medium text-[#596476]">
                  No calls yet
                </p>

                <p className="mt-1 text-xs text-[#8a93a3]">
                  Start a call to create the first call record.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[#e5e7eb]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#f8fafc]">
                    <tr className="border-b border-[#e5e7eb]">
                      <th className="px-5 py-3 text-left font-semibold text-[#596476]">
                        Date
                      </th>

                      <th className="px-5 py-3 text-left font-semibold text-[#596476]">
                        Status
                      </th>

                      <th className="px-5 py-3 text-left font-semibold text-[#596476]">
                        Duration
                      </th>

                      <th className="px-5 py-3 text-left font-semibold text-[#596476]">
                        Action
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {calls.map(
                      (call) => (
                        <tr
                          key={call.id}
                          className="border-b border-[#e5e7eb] last:border-0 hover:bg-[#fafbfc]"
                        >
                          <td className="px-5 py-4 text-[#596476]">
                            {call.createdAt
                              ? new Date(
                                  call.createdAt
                                ).toLocaleString()
                              : "—"}
                          </td>

                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${
                                call.status ===
                                "COMPLETED"
                                  ? "border-green-200 bg-green-50 text-green-700"
                                  : call.status ===
                                      "BUSY"
                                    ? "border-orange-200 bg-orange-50 text-orange-700"
                                    : call.status ===
                                        "FAILED"
                                      ? "border-red-200 bg-red-50 text-red-700"
                                      : call.status ===
                                          "NO_ANSWER"
                                        ? "border-yellow-200 bg-yellow-50 text-yellow-700"
                                        : "border-blue-200 bg-blue-50 text-blue-700"
                              }`}
                            >
                              {
                                call.status
                              }
                            </span>
                          </td>

                          <td className="px-5 py-4 font-medium text-[#172033]">
                            {call.durationSeconds !==
                              null &&
                            call.durationSeconds !==
                              undefined
                              ? `${call.durationSeconds} sec`
                              : "—"}
                          </td>

                          <td className="px-5 py-4">
                            {call.status ===
                            "COMPLETED" ? (
                              <button
                                type="button"
                                onClick={() =>
                                  handleOpenNotes(
                                    call
                                  )
                                }
                                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                              >
                                {call.manualNotes
                                  ? "Edit Notes"
                                  : "Add Notes"}
                              </button>
                            ) : (
                              <span className="text-xs text-[#9aa2b1]">
                                —
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* CALL SUMMARY / MANUAL NOTES */}

        {selectedCallId && (
          <section className="mt-6 rounded-2xl border border-blue-100 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold">
                  Call Summary
                </h3>

                <p className="mt-1 text-sm text-[#8a93a3]">
                  Add notes about the conversation with this customer.
                </p>
              </div>

              <button
                type="button"
                onClick={
                  handleCloseNotes
                }
                className="rounded-lg border border-[#dfe3e8] px-4 py-2 text-sm font-semibold text-[#4e596b] hover:bg-[#f5f6f8]"
              >
                Cancel
              </button>
            </div>

            <div>
              <label
                htmlFor="manualNotes"
                className="mb-2 block text-sm font-semibold text-[#172033]"
              >
                How did the call go?
              </label>

              <textarea
                id="manualNotes"
                value={manualNotes}
                onChange={(event) =>
                  setManualNotes(
                    event.target.value
                  )
                }
                placeholder="Enter important sales notes, customer requirements, customer names, decision makers, concerns, commitments, requested information, and next steps..."
                rows={7}
                className="w-full rounded-xl border border-[#dfe3e8] bg-white p-4 text-sm text-[#172033] outline-none placeholder:text-[#9aa2b1] focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>

            {/* NOTES ACTIONS */}

            <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                {notesMessage ? (
                  <p
                    className={
                      notesMessage.includes(
                        "successfully"
                      )
                        ? "text-green-600"
                        : "text-red-600"
                    }
                  >
                    {notesMessage}
                  </p>
                ) : (
                  <p className="text-xs text-[#8a93a3]">
                    Save your notes before asking Gemini to analyze the call.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={
                    handleSaveNotes
                  }
                  disabled={
                    savingNotes ||
                    analyzingCall
                  }
                  className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingNotes
                    ? "Saving..."
                    : "Save Notes"}
                </button>

                <button
                  type="button"
                  onClick={
                    handleAnalyzeCall
                  }
                  disabled={
                    analyzingCall ||
                    savingNotes ||
                    !manualNotes.trim()
                  }
                  className="rounded-xl bg-purple-600 px-6 py-3 text-sm font-bold text-white shadow-sm hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {analyzingCall
                    ? "Analyzing..."
                    : "Analyze with Gemini"}
                </button>
              </div>
            </div>

            {/* ANALYSIS MESSAGE */}

            {analysisMessage && (
              <div
                className={`mt-5 rounded-xl border p-4 text-sm ${
                  analysisMessage.includes(
                    "successfully"
                  )
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {analysisMessage}
              </div>
            )}

            {/* AI ANALYSIS + HUMAN REVIEW */}

            {aiAnalysis && (
              <div className="mt-6 rounded-2xl border border-purple-100 bg-purple-50/40 p-6">
                <div className="mb-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h4 className="text-lg font-bold text-[#172033]">
                        Gemini Analysis
                      </h4>

                      <p className="mt-1 text-sm text-[#7c8697]">
                        Review the AI-generated analysis and approve it before it becomes the final CRM decision.
                      </p>
                    </div>

                    {aiAnalysis.humanReviewed ? (
                      <span className="inline-flex w-fit rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
                        Human Approved
                      </span>
                    ) : (
                      <span className="inline-flex w-fit rounded-full border border-purple-200 bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                        AI Generated
                      </span>
                    )}
                  </div>
                </div>

                {/* HUMAN REVIEW FORM */}

                <div className="rounded-xl border border-[#e5e7eb] bg-white p-5">
                  <div className="mb-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                      Human Review
                    </p>

                    <p className="mt-1 text-xs text-[#8a93a3]">
                      Edit any AI recommendation if needed, then accept and save the final decision.
                    </p>
                  </div>

                  {/* SUMMARY */}

                  <div>
                    <label
                      htmlFor="reviewSummary"
                      className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[#8a93a3]"
                    >
                      Summary
                    </label>

                    <textarea
                      id="reviewSummary"
                      value={
                        aiAnalysis.summary
                      }
                      onChange={(event) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          summary:
                            event.target
                              .value,
                          humanReviewed:
                            false,
                        })
                      }
                      rows={4}
                      className="w-full rounded-xl border border-[#dfe3e8] bg-white p-3 text-sm leading-6 text-[#172033] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>

                  {/* MAIN DECISIONS */}

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <ReviewSelect
                      label="Outcome"
                      value={
                        aiAnalysis.outcome
                      }
                      options={[
                        "INTERESTED",
                        "FOLLOW_UP_REQUIRED",
                        "CALL_BACK_REQUESTED",
                        "NOT_INTERESTED",
                        "PRICE_OBJECTION",
                        "NEEDS_DISCUSSION",
                        "DECISION_PENDING",
                        "MEETING_REQUIRED",
                        "DEMO_REQUIRED",
                        "CONVERTED",
                        "NO_RESPONSE",
                        "WRONG_NUMBER",
                        "LOST",
                        "OTHER",
                      ]}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          outcome: value,
                          humanReviewed:
                            false,
                        })
                      }
                    />

                    <ReviewSelect
                      label="Interest"
                      value={
                        aiAnalysis.interest
                      }
                      options={[
                        "HIGH",
                        "MEDIUM",
                        "LOW",
                        "UNKNOWN",
                      ]}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          interest: value,
                          humanReviewed:
                            false,
                        })
                      }
                    />

                    <ReviewSelect
                      label="Next Action"
                      value={
                        aiAnalysis.nextAction
                      }
                      options={[
                        "FOLLOW_UP",
                        "CALL_BACK",
                        "SEND_QUOTATION",
                        "SEND_INFORMATION",
                        "SCHEDULE_MEETING",
                        "SCHEDULE_DEMO",
                        "WAIT_FOR_CUSTOMER",
                        "MOVE_TO_ONBOARDING",
                        "NO_ACTION",
                        "RETRY_CALL",
                      ]}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          nextAction: value,
                          humanReviewed:
                            false,
                        })
                      }
                    />

                    <ReviewSelect
                      label="Priority"
                      value={
                        aiAnalysis.priority
                      }
                      options={[
                        "HIGH",
                        "MEDIUM",
                        "LOW",
                      ]}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          priority: value,
                          humanReviewed:
                            false,
                        })
                      }
                    />
                  </div>

                  {/* REQUIREMENT / NOTES */}

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <ReviewTextarea
                      label="Requirement"
                      value={
                        aiAnalysis.requirement ||
                        ""
                      }
                      placeholder="Customer requirement"
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          requirement:
                            value,
                          humanReviewed:
                            false,
                        })
                      }
                    />

                    <ReviewTextarea
                      label="Notes"
                      value={
                        aiAnalysis.objection ||
                        ""
                      }
                      placeholder="Add important sales notes such as customer names, decision makers, requirements, concerns, requested information, commitments, or next steps."
                      rows={5}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          objection:
                            value,
                          humanReviewed:
                            false,
                        })
                      }
                    />
                  </div>

                  {/* FOLLOW-UP */}

                  <div className="mt-4 rounded-xl border border-[#e5e7eb] bg-white p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                          Follow-up Required
                        </p>

                        <p className="mt-1 text-xs text-[#8a93a3]">
                          Should the salesperson follow up with this customer?
                        </p>
                      </div>

                      <select
                        value={
                          aiAnalysis.followUpRequired
                            ? "YES"
                            : "NO"
                        }
                        onChange={(event) =>
                          setAiAnalysis({
                            ...aiAnalysis,
                            followUpRequired:
                              event.target
                                .value ===
                              "YES",
                            humanReviewed:
                              false,
                          })
                        }
                        className="rounded-lg border border-[#dfe3e8] bg-white px-3 py-2 text-sm font-semibold text-[#172033] outline-none focus:border-blue-500"
                      >
                        <option value="YES">
                          Yes
                        </option>

                        <option value="NO">
                          No
                        </option>
                      </select>
                    </div>

                    {aiAnalysis.followUpRequired && (
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor="followUpDate"
                            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[#8a93a3]"
                          >
                            Follow-up Date
                          </label>

                          <input
                            id="followUpDate"
                            type="date"
                            value={
                              normalizeDateOnly(
                                aiAnalysis.followUpDate
                              ) || ""
                            }
                            onChange={(
                              event
                            ) =>
                              setAiAnalysis({
                                ...aiAnalysis,
                                followUpDate:
                                  event.target
                                    .value ||
                                  null,
                                humanReviewed:
                                  false,
                              })
                            }
                            className="w-full rounded-lg border border-[#dfe3e8] px-3 py-2 text-sm outline-none focus:border-blue-500"
                          />
                        </div>

                        <div>
                          <label
                            htmlFor="followUpTime"
                            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[#8a93a3]"
                          >
                            Follow-up Time
                          </label>

                          <input
                            id="followUpTime"
                            type="time"
                            value={
                              aiAnalysis.followUpTime ||
                              ""
                            }
                            onChange={(
                              event
                            ) =>
                              setAiAnalysis({
                                ...aiAnalysis,
                                followUpTime:
                                  event.target
                                    .value ||
                                  null,
                                humanReviewed:
                                  false,
                              })
                            }
                            className="w-full rounded-lg border border-[#dfe3e8] px-3 py-2 text-sm outline-none focus:border-blue-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* REASON */}

                  <div className="mt-4">
                    <ReviewTextarea
                      label="Reason"
                      value={
                        aiAnalysis.reason
                      }
                      placeholder="Reason for the recommendation"
                      rows={4}
                      onChange={(value) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          reason: value,
                          humanReviewed:
                            false,
                        })
                      }
                    />
                  </div>

                  {/* CONFIDENCE */}

                  <div className="mt-4 rounded-xl border border-[#e5e7eb] bg-white p-5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                        Confidence
                      </p>

                      <span className="text-sm font-bold text-[#172033]">
                        {Math.round(
                          aiAnalysis.confidence *
                            100
                        )}
                        %
                      </span>
                    </div>

                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={
                        aiAnalysis.confidence
                      }
                      onChange={(event) =>
                        setAiAnalysis({
                          ...aiAnalysis,
                          confidence:
                            Number(
                              event.target
                                .value
                            ),
                          humanReviewed:
                            false,
                        })
                      }
                      className="mt-4 w-full"
                    />
                  </div>

                  {/* REVIEW ACTION */}

                  <div className="mt-6 border-t border-[#e5e7eb] pt-5">
                    {reviewMessage && (
                      <div
                        className={`mb-4 rounded-xl border p-4 text-sm ${
                          reviewMessage.includes(
                            "successfully"
                          )
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-red-200 bg-red-50 text-red-700"
                        }`}
                      >
                        {reviewMessage}
                      </div>
                    )}

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        {aiAnalysis.humanReviewed ? (
                          <p className="text-xs text-green-700">
                            Approved by{" "}
                            {aiAnalysis.reviewedBy ||
                              customer.assignedTo ||
                              "salesperson"}

                            {aiAnalysis.reviewedAt
                              ? ` on ${new Date(
                                  aiAnalysis.reviewedAt
                                ).toLocaleString()}`
                              : ""}
                          </p>
                        ) : (
                          <p className="text-xs text-[#8a93a3]">
                            Review the information above before accepting it.
                          </p>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={
                          handleSaveHumanReview
                        }
                        disabled={
                          reviewSaving
                        }
                        className="rounded-xl bg-green-600 px-6 py-3 text-sm font-bold text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {reviewSaving
                          ? "Saving Review..."
                          : aiAnalysis.humanReviewed
                            ? "Update & Save Review"
                            : "Accept & Save Analysis"}
                      </button>
                    </div>
                  </div>

                  <p className="mt-4 text-xs text-[#8a93a3]">
                    AI Model:{" "}
                    {aiAnalysis.model}
                  </p>
                </div>
              </div>
            )}
          </section>
        )}

        {/* FOLLOW-UP */}

        <section className="mt-6 rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold">
                Follow-up
              </h3>

              <p className="mt-1 text-sm text-[#8a93a3]">
                Follow-up tasks created from the approved CRM analysis.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                loadFollowUpTasks(
                  customer.id
                )
              }
              disabled={
                followUpLoading
              }
              className="rounded-lg border border-[#dfe3e8] bg-white px-4 py-2 text-sm font-semibold text-[#4e596b] hover:bg-[#f5f6f8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {followUpLoading
                ? "Refreshing..."
                : "Refresh"}
            </button>
          </div>

          {followUpError && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {followUpError}
            </div>
          )}

          {followUpLoading &&
          followUpTasks.length ===
            0 ? (
            <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed border-[#dfe3e8] bg-[#fafbfc]">
              <p className="text-sm text-[#8a93a3]">
                Loading follow-up tasks...
              </p>
            </div>
          ) : followUpTasks.length ===
            0 ? (
            <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed border-[#dfe3e8] bg-[#fafbfc]">
              <div className="text-center">
                <CalendarDays
                  size={28}
                  className="mx-auto mb-2 text-[#aab2bf]"
                />

                <p className="text-sm font-medium text-[#596476]">
                  No follow-up tasks
                </p>

                <p className="mt-1 text-xs text-[#8a93a3]">
                  A task will appear here when a reviewed call requires follow-up.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {followUpTasks.map(
                (task) => (
                  <div
                    key={task.id}
                    className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-5"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-bold text-[#172033]">
                            {task.title}
                          </h4>

                          <span
                            className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${
                              task.status?.toUpperCase() ===
                              "COMPLETED"
                                ? "border-green-200 bg-green-50 text-green-700"
                                : task.status?.toUpperCase() ===
                                    "CANCELLED"
                                  ? "border-red-200 bg-red-50 text-red-700"
                                  : "border-orange-200 bg-orange-50 text-orange-700"
                            }`}
                          >
                            {formatValue(
                              task.status ||
                                "PENDING"
                            )}
                          </span>

                          <PriorityBadge
                            value={
                              task.priority ||
                              "MEDIUM"
                            }
                          />
                        </div>

                        {task.description && (
                          <p className="mt-2 text-sm leading-6 text-[#596476]">
                            {
                              task.description
                            }
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 border-t border-[#e5e7eb] pt-4 sm:grid-cols-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                          Assigned To
                        </p>

                        <p className="mt-1 text-sm font-semibold text-[#172033]">
                          {task.assignedTo ||
                            customer.assignedTo ||
                            "sales-001"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                          Due Date
                        </p>

                        <p className="mt-1 text-sm font-semibold text-[#172033]">
                          {task.dueDate
                            ? new Date(
                                task.dueDate
                              ).toLocaleDateString()
                            : "Not scheduled"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
                          Due Time
                        </p>

                        <p className="mt-1 text-sm font-semibold text-[#172033]">
                          {task.dueTime ||
                            "Not scheduled"}
                        </p>
                      </div>
                    </div>

                    <p className="mt-4 text-xs text-[#9aa2b1]">
                      Task ID:{" "}
                      {task.id}
                    </p>
                  </div>
                )
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

/* -------------------------------------------------- */
/* ANALYSIS CARD                                      */
/* -------------------------------------------------- */

function AnalysisCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
        {label}
      </p>

      <p className="mt-2 text-sm font-bold text-[#172033]">
        {value}
      </p>
    </div>
  );
}

/* -------------------------------------------------- */
/* ANALYSIS TEXT CARD                                 */
/* -------------------------------------------------- */

function AnalysisTextCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
        {label}
      </p>

      <p className="mt-2 text-sm leading-6 text-[#172033]">
        {value}
      </p>
    </div>
  );
}

/* -------------------------------------------------- */
/* REVIEW SELECT                                      */
/* -------------------------------------------------- */

function ReviewSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
        {label}
      </label>

      <select
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value
          )
        }
        className="w-full rounded-lg border border-[#dfe3e8] bg-white px-3 py-2.5 text-sm font-semibold text-[#172033] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      >
        {options.map(
          (option) => (
            <option
              key={option}
              value={option}
            >
              {formatValue(
                option
              )}
            </option>
          )
        )}
      </select>
    </div>
  );
}

/* -------------------------------------------------- */
/* REVIEW TEXTAREA                                    */
/* -------------------------------------------------- */

function ReviewTextarea({
  label,
  value,
  placeholder,
  rows = 4,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[#8a93a3]">
        {label}
      </label>

      <textarea
        value={value}
        placeholder={
          placeholder
        }
        rows={rows}
        onChange={(event) =>
          onChange(
            event.target.value
          )
        }
        className="w-full rounded-xl border border-[#dfe3e8] bg-white p-3 text-sm leading-6 text-[#172033] outline-none placeholder:text-[#9aa2b1] focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      />
    </div>
  );
}

/* -------------------------------------------------- */
/* FORMAT AI VALUES                                   */
/* -------------------------------------------------- */

function formatValue(
  value: string
) {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(
      /\b\w/g,
      (letter) =>
        letter.toUpperCase()
    );
}

/* -------------------------------------------------- */
/* INFORMATION ROW                                    */
/* -------------------------------------------------- */

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
        {icon}
      </div>

      <div>
        <p className="text-xs font-medium text-[#8a93a3]">
          {label}
        </p>

        <p className="mt-1 text-sm font-semibold text-[#172033]">
          {value}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------- */
/* STATUS BADGE                                       */
/* -------------------------------------------------- */

function StatusBadge({
  value,
}: {
  value: string;
}) {
  return (
    <span className="inline-flex rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
      {value}
    </span>
  );
}

/* -------------------------------------------------- */
/* PRIORITY BADGE                                     */
/* -------------------------------------------------- */

function PriorityBadge({
  value,
}: {
  value: string;
}) {
  const normalized =
    value.toUpperCase();

  const classes =
    normalized === "HIGH"
      ? "border-red-200 bg-red-50 text-red-700"
      : normalized === "LOW"
        ? "border-gray-200 bg-gray-50 text-gray-600"
        : "border-orange-200 bg-orange-50 text-orange-700";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${classes}`}
    >
      {value}
    </span>
  );
}