import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Phone,
  Mail,
  MessageSquare,
  PhoneCall,
  Clock,
  CheckCircle2,
  Calendar,
  Sparkles,
  CalendarClock,
  Pencil,
} from 'lucide-react';
import { api } from '../api/client';
import { PlaceCallModal } from '../components/calls/PlaceCallModal';
import { useAuth } from '../context/AuthContext';

export const ContactDetailPage: React.FC = () => {
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [contact, setContact] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [callDetails, setCallDetails] = useState<Record<string, any>>({});
  const [isCallOpen, setIsCallOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canCall = user?.permissions.includes('calls:trigger') === true;

  // Follow-up editor state — keyed to whichever call is currently being edited
  const [editingCallId, setEditingCallId] = useState<string | null>(null);
  const [draftOutcome, setDraftOutcome] = useState('interested');
  const [draftRequirement, setDraftRequirement] = useState('');
  const [draftObjection, setDraftObjection] = useState('');
  const [draftFollowUpRequired, setDraftFollowUpRequired] = useState(false);
  const [draftFollowUpDate, setDraftFollowUpDate] = useState('');
  const [draftFollowUpTime, setDraftFollowUpTime] = useState('');
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false);

  const loadContact = async () => {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const [contactData, timelineData] = await Promise.all([
        api.contacts.get(id),
        api.contacts.getTimeline(id),
      ]);
      setContact(contactData);
      const events = timelineData.timeline || [];
      setTimeline(events);

      // Fetch full call data for every call-related event, so follow-up info
      // shown here is always the latest saved state, not a stale snapshot.
      const callIds = Array.from(
        new Set(events.filter((e: any) => e.channel === 'call' && e.callId).map((e: any) => e.callId)),
      ) as string[];
      const details: Record<string, any> = {};
      await Promise.all(
        callIds.map(async (callId) => {
          try {
            details[callId] = await api.calls.get(callId);
          } catch {
            // If one call fails to load, the rest of the timeline still renders.
          }
        }),
      );
      setCallDetails(details);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load contact details.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadContact();
  }, [id]);

  const startEditingFollowUp = (callId: string) => {
    const call = callDetails[callId] || {};
    setEditingCallId(callId);
    setDraftOutcome(call.salesOutcome || 'interested');
    setDraftRequirement(call.requirement || '');
    setDraftObjection(call.objection || '');
    setDraftFollowUpRequired(call.followUpRequired ?? false);
    setDraftFollowUpDate(call.followUpDate || '');
    setDraftFollowUpTime(call.followUpTime || '');
  };

  const saveFollowUp = async () => {
    if (!editingCallId) return;
    setIsSavingFollowUp(true);
    try {
      const updated = await api.calls.update(editingCallId, {
        salesOutcome: draftOutcome,
        requirement: draftRequirement,
        objection: draftObjection,
        followUpRequired: draftFollowUpRequired,
        followUpDate: draftFollowUpDate,
        followUpTime: draftFollowUpTime,
      });
      setCallDetails((prev) => ({ ...prev, [editingCallId]: updated }));
      setEditingCallId(null);
    } catch (err) {
      console.error('Failed to save follow-up:', err);
    } finally {
      setIsSavingFollowUp(false);
    }
  };

  if (isLoading) {
    return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading 360° interaction timeline...</div>;
  }

  if (error || !contact) {
    return <div className="data-card empty-state" role="alert"><h3>Contact unavailable</h3><p>{error || 'This contact could not be found.'}</p><button type="button" className="btn btn-secondary" onClick={() => navigate('/contacts')}>Back to Contacts</button></div>;
  }

  return (
    <div>
      {/* Header Back Button */}
      <button
        onClick={() => navigate('/contacts')}
        className="btn btn-ghost btn-sm"
        style={{ marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        <ArrowLeft size={16} />
        <span>Back to Contacts</span>
      </button>

      {/* Two Column Layout: Profile Card & 360° Timeline */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '28px' }}>
        {/* Left Column: Customer Profile */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="data-card" style={{ padding: '28px' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: '#eff6ff',
                border: '2px solid #bfdbfe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '1.4rem',
                color: '#004e9f',
                marginBottom: '16px',
              }}
            >
              {contact?.fullName?.charAt(0) || 'C'}
            </div>

            <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
              {contact?.fullName}
            </h2>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
              Customer Record · {contact?.id?.slice(0, 10)}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Phone size={16} color="#64748b" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {contact?.phone}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Mail size={16} color="#64748b" />
                <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  {contact?.email || 'No email registered'}
                </span>
              </div>
            </div>

            {/* Channel Opt-in Badges */}
            <div style={{ marginTop: '20px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                Channel Permissions
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {contact?.whatsappOptedIn ? (
                  <span className="badge badge-emerald">
                    <CheckCircle2 size={12} /> WhatsApp Enabled
                  </span>
                ) : (
                  <span className="badge badge-slate">WhatsApp Disabled</span>
                )}
                {contact?.emailOptedIn ? (
                  <span className="badge badge-indigo">
                    <CheckCircle2 size={12} /> Email Enabled
                  </span>
                ) : (
                  <span className="badge badge-slate">Email Disabled</span>
                )}
              </div>
            </div>

            {/* Action button */}
            {canCall && <button
              onClick={() => setIsCallOpen(true)}
              className="btn btn-emerald btn-lg"
              style={{ marginTop: '24px', width: '100%' }}
            >
              <PhoneCall size={18} />
              <span>Place Call to Customer</span>
            </button>}
          </div>
        </div>

        {/* Right Column: 360° Timeline */}
        <div className="data-card" style={{ padding: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)' }}>360° Interaction Timeline</h3>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Unified chronological feed of WhatsApp messages, AI phone calls, and email broadcasts
              </p>
            </div>
            <span className="badge badge-indigo">{timeline.length} Events</span>
          </div>

          {/* Timeline Stream */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', position: 'relative', paddingLeft: '24px' }}>
            {/* Vertical Line */}
            <div
              style={{
                position: 'absolute',
                left: '7px',
                top: '12px',
                bottom: '12px',
                width: '2px',
                background: 'var(--border-subtle)',
              }}
            />

            {timeline.length > 0 ? (
              timeline.map((event: any, idx: number) => {
                const isCall = event.channel === 'call';
                const isWA = event.channel === 'whatsapp';
                const isEmail = event.channel === 'email';
                const call = event.callId ? callDetails[event.callId] : null;
                const isEditingThisCall = editingCallId === event.callId;

                return (
                  <div key={event.id || idx} style={{ position: 'relative' }}>
                    {/* Node Dot */}
                    <div
                      style={{
                        position: 'absolute',
                        left: '-24px',
                        top: '4px',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: '#ffffff',
                        border: isCall ? '3px solid #7c3aed' : isWA ? '3px solid #34a853' : '3px solid #004e9f',
                        boxShadow: '0 0 0 3px #ffffff',
                      }}
                    />

                    {/* Content Box */}
                    <div
                      style={{
                        padding: '16px',
                        background: '#f8fafc',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span
                            className={`badge ${
                              isCall ? 'badge-slate' : isWA ? 'badge-emerald' : 'badge-indigo'
                            }`}
                            style={{ textTransform: 'uppercase' }}
                          >
                            {isCall && <PhoneCall size={11} />}
                            {isWA && <MessageSquare size={11} />}
                            {isEmail && <Mail size={11} />}
                            {event.channel}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          <Clock size={12} />
                          <span>{event.occurredAt ? new Date(event.occurredAt).toLocaleString() : '—'}</span>
                        </div>
                      </div>

                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        {event.summary || 'No additional details are available.'}
                      </div>

                      {/* Sales Follow-up — only for call events tied to a real call record */}
                      {isCall && event.callId && (
                        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed #e2e8f0' }}>
                          {!isEditingThisCall ? (
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                              <div style={{ fontSize: '0.8rem', color: '#92400e' }}>
                                {call?.followUpRequired && call?.followUpDate ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                                    <CalendarClock size={13} />
                                    <span>
                                      Follow-up: {call.followUpDate}
                                      {call.followUpTime ? ` at ${call.followUpTime}` : ''}
                                    </span>
                                  </div>
                                ) : (
                                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No follow-up scheduled.</span>
                                )}
                                {call?.requirement && (
                                  <div style={{ marginTop: '4px', color: 'var(--text-secondary)' }}>
                                    Requirement: {call.requirement}
                                  </div>
                                )}
                                {call?.objection && (
                                  <div style={{ marginTop: '2px', color: 'var(--text-secondary)' }}>
                                    Objection: {call.objection}
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={() => startEditingFollowUp(event.callId)}
                                className="btn btn-secondary btn-sm"
                                style={{ flexShrink: 0, gap: '4px' }}
                              >
                                <Pencil size={12} />
                                <span>Edit</span>
                              </button>
                            </div>
                          ) : (
                            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 'var(--radius-md)', padding: '12px' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>OUTCOME</label>
                                  <select
                                    value={draftOutcome}
                                    onChange={(e) => setDraftOutcome(e.target.value)}
                                    style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                  >
                                    <option value="interested">Interested</option>
                                    <option value="not_interested">Not Interested</option>
                                    <option value="callback_requested">Callback Requested</option>
                                    <option value="converted">Converted</option>
                                  </select>
                                </div>
                                <div>
                                  <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>FOLLOW-UP REQUIRED?</label>
                                  <select
                                    value={draftFollowUpRequired ? 'yes' : 'no'}
                                    onChange={(e) => setDraftFollowUpRequired(e.target.value === 'yes')}
                                    style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                  >
                                    <option value="no">No</option>
                                    <option value="yes">Yes</option>
                                  </select>
                                </div>
                              </div>

                              <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>REQUIREMENT</label>
                                <input
                                  type="text"
                                  value={draftRequirement}
                                  onChange={(e) => setDraftRequirement(e.target.value)}
                                  placeholder="What the customer needs"
                                  style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                />
                              </div>

                              <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>OBJECTION</label>
                                <input
                                  type="text"
                                  value={draftObjection}
                                  onChange={(e) => setDraftObjection(e.target.value)}
                                  placeholder="Why they're hesitant, if any"
                                  style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                />
                              </div>

                              {draftFollowUpRequired && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                                  <div>
                                    <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>FOLLOW-UP DATE</label>
                                    <input
                                      type="date"
                                      value={draftFollowUpDate}
                                      onChange={(e) => setDraftFollowUpDate(e.target.value)}
                                      style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                    />
                                  </div>
                                  <div>
                                    <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>FOLLOW-UP TIME</label>
                                    <input
                                      type="time"
                                      value={draftFollowUpTime}
                                      onChange={(e) => setDraftFollowUpTime(e.target.value)}
                                      style={{ width: '100%', padding: '5px 7px', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #fde68a' }}
                                    />
                                  </div>
                                </div>
                              )}

                              <div style={{ display: 'flex', gap: '8px' }}>
                                <button
                                  onClick={saveFollowUp}
                                  disabled={isSavingFollowUp}
                                  className="btn btn-emerald btn-sm"
                                  style={{ flex: 1, justifyContent: 'center' }}
                                >
                                  {isSavingFollowUp ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  onClick={() => setEditingCallId(null)}
                                  className="btn btn-secondary btn-sm"
                                  style={{ flex: 1, justifyContent: 'center' }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', padding: '20px 0' }}>
                {canCall ? 'No past interactions are recorded yet. Place a call to start the first conversation.' : 'No past interactions are recorded for this contact yet.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Place Call Modal */}
      {isCallOpen && (
        <PlaceCallModal
          isOpen={isCallOpen}
          defaultPhone={contact?.phone}
          onClose={() => setIsCallOpen(false)}
          onSuccess={() => {
            loadContact();
            setIsCallOpen(false);
          }}
        />
      )}
    </div>
  );
};