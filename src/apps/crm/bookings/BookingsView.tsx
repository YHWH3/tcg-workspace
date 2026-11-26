import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  AlertTriangle,
  ArrowRightLeft,
  Calendar,
  CheckCircle2,
  Clock,
  CloudOff,
  Lock,
  Plus,
  RefreshCw,
  ShieldAlert,
  Ticket,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import {
  formatMinorMoney,
  type AttendanceState,
  type BookingDetailResponse,
  type BookingScreeningResponse,
  type BookingState,
  type CrmBookingDto,
  type CrmEditionDto,
  type CrmParticipantDto,
  type EditionDetailResponse,
  type EditionState,
  type ScreeningState,
} from '../../../../shared/crm/operations';
import { CRM_PROGRAMMES } from '../../../../shared/crm/programmes';
import { authStore } from '../../../core/auth';
import { useLayoutMode } from '../../../core/mobile';
import { recordTitle } from '../../../core/records';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import {
  acceptWaitlistOffer,
  cancelBooking,
  completeEdition,
  confirmBooking,
  describeCommandError,
  fetchBookingDetail,
  fetchBookingScreening,
  fetchEditionDetail,
  fetchEditions,
  holdBooking,
  isIdentityChangedError,
  listOfflineBookingIntents,
  offerWaitlist,
  recordAttendance,
  removeOfflineBookingIntent,
  requestBooking,
  reviewScreening,
  saveOfflineBookingIntent,
  transferBooking,
  updateParticipant,
  upsertEdition,
  upsertScreening,
  type OfflineBookingRequestIntent,
} from '../api';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

function stateBadgeStyle(state: BookingState | EditionState): { bg: string; fg: string } {
  switch (state) {
    case 'confirmed':
    case 'open':
    case 'completed':
      return { bg: 'var(--crm-status-river)', fg: 'var(--crm-status-fg)' };
    case 'held':
    case 'offered':
    case 'awaiting_payment':
    case 'waitlisted':
      return { bg: 'var(--crm-warn-bg)', fg: 'var(--crm-warn-text)' };
    case 'paid_without_seat':
    case 'cancelled':
    case 'expired':
      return { bg: 'var(--crm-err-bg)', fg: 'var(--crm-err-text)' };
    default:
      return { bg: 'var(--crm-surface-2)', fg: 'var(--crm-text)' };
  }
}

export function BookingsView({ status }: { status: CrmStatus }) {
  const { editionId: routeEditionId } = useParams();
  const navigate = useNavigate();
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const currentUser = useStore(authStore).user;
  const uid = currentUser?.id ?? null;
  const { peopleDb, eventsDb, tasks } = useCrmDatabases();

  const canConfigure = status.owner || status.capabilities.some((c) => c.capability === 'crm.configure');

  const peopleOptions = useMemo(() => {
    if (!peopleDb) return [];
    return tasks
      .filter((t) => !t.deleted && !t.archived && t.boardId === peopleDb.id)
      .map((t) => ({ id: t.id, title: recordTitle(t) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [peopleDb, tasks]);

  const eventOptions = useMemo(() => {
    if (!eventsDb) return [];
    return tasks
      .filter((t) => !t.deleted && !t.archived && t.boardId === eventsDb.id)
      .map((t) => ({ id: t.id, title: recordTitle(t) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [eventsDb, tasks]);

  const [editions, setEditions] = useState<CrmEditionDto[]>([]);
  const [selectedEditionId, setSelectedEditionId] = useState<string>(routeEditionId ?? '');
  const [editionDetail, setEditionDetail] = useState<EditionDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Offline visibly-unconfirmed booking request intents (scoped per account)
  const [offlineIntents, setOfflineIntents] = useState<OfflineBookingRequestIntent[]>([]);

  // Dialog states
  const [editionModalOpen, setEditionModalOpen] = useState(false);
  const [editingEdition, setEditingEdition] = useState<CrmEditionDto | null>(null);
  const [bookingModalOpen, setBookingModalOpen] = useState(false);

  // Selected booking detail drawer/dialog
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [bookingDetail, setBookingDetail] = useState<BookingDetailResponse | null>(null);
  const [bookingDetailLoading, setBookingDetailLoading] = useState(false);
  const [screeningData, setScreeningData] = useState<BookingScreeningResponse | null>(null);
  const [screeningError, setScreeningError] = useState<string | null>(null);

  // Edition form fields
  const [edEventId, setEdEventId] = useState('');
  const [edProgramme, setEdProgramme] = useState<string>(CRM_PROGRAMMES[0]?.slug ?? 'tribal-habitat-workshop');
  const [edTitle, setEdTitle] = useState('');
  const [edCapacity, setEdCapacity] = useState('');
  const [edHoldMinutes, setEdHoldMinutes] = useState('');
  const [edMaxGroup, setEdMaxGroup] = useState('');
  const [edConfirmBeforePayment, setEdConfirmBeforePayment] = useState<'unset' | 'yes' | 'no'>('unset');
  const [edRequiresScreening, setEdRequiresScreening] = useState(false);
  const [edScreeningQs, setEdScreeningQs] = useState('');
  const [edCancelPolicy, setEdCancelPolicy] = useState('');
  const [edPriceLabel, setEdPriceLabel] = useState('Standard');
  const [edPriceMajor, setEdPriceMajor] = useState('');
  const [edSessionDates, setEdSessionDates] = useState('');
  const [edState, setEdState] = useState<EditionState>('open');

  // Booking request form fields
  const [bkPersonId, setBkPersonId] = useState('');
  const [bkSeats, setBkSeats] = useState('1');
  const [bkPriceOptionId, setBkPriceOptionId] = useState('');
  const [bkParticipantNames, setBkParticipantNames] = useState('');
  const [bkPreferWaitlist, setBkPreferWaitlist] = useState(false);
  const [bkNotes, setBkNotes] = useState('');

  // Booking detail action states
  const [cancelReason, setCancelReason] = useState('');
  const [transferTargetId, setTransferTargetId] = useState('');
  const [editingParticipant, setEditingParticipant] = useState<CrmParticipantDto | null>(null);
  const [partNameDraft, setPartNameDraft] = useState('');
  const [partPersonDraft, setPartPersonDraft] = useState('');
  const [screeningParticipantId, setScreeningParticipantId] = useState('');
  const [screeningAnswerText, setScreeningAnswerText] = useState('');
  const [screeningReviewState, setScreeningReviewState] = useState<ScreeningState>('cleared');
  const [screeningReviewNote, setScreeningReviewNote] = useState('');

  // Clear all sensitive / session-bound state on account switch
  useEffect(() => {
    setEditions([]);
    setEditionDetail(null);
    setSelectedBookingId(null);
    setBookingDetail(null);
    setScreeningData(null);
    setScreeningError(null);
    setError(null);
    setNotice(null);
    setOfflineIntents(listOfflineBookingIntents(uid));
  }, [uid, status.owner, status.capabilities.length]);

  useEffect(() => {
    if (routeEditionId && routeEditionId !== selectedEditionId) {
      setSelectedEditionId(routeEditionId);
    }
  }, [routeEditionId, selectedEditionId]);

  const loadEditions = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchEditions();
      setEditions(res.items);
      setSelectedEditionId((prev) => {
        if (prev && res.items.some((e) => e.id === prev)) return prev;
        return routeEditionId && res.items.some((e) => e.id === routeEditionId)
          ? routeEditionId
          : (res.items[0]?.id ?? '');
      });
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline, routeEditionId]);

  const loadEditionDetail = useCallback(
    async (id: string) => {
      if (!id || isOffline) return;
      setDetailLoading(true);
      setError(null);
      try {
        const res = await fetchEditionDetail(id);
        setEditionDetail(res);
      } catch (err) {
        if (!isIdentityChangedError(err)) setError(describeCommandError(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [isOffline],
  );

  const loadBookingDetail = useCallback(
    async (bookingId: string) => {
      if (!bookingId || isOffline) return;
      setBookingDetailLoading(true);
      setScreeningData(null);
      setScreeningError(null);
      try {
        const detail = await fetchBookingDetail(bookingId);
        setBookingDetail(detail);
        if (detail.canReadScreening) {
          try {
            const scr = await fetchBookingScreening(bookingId);
            setScreeningData(scr);
          } catch (scrErr) {
            if (!isIdentityChangedError(scrErr)) setScreeningError(describeCommandError(scrErr));
          }
        }
      } catch (err) {
        if (!isIdentityChangedError(err)) setError(describeCommandError(err));
      } finally {
        setBookingDetailLoading(false);
      }
    },
    [isOffline],
  );

  useEffect(() => {
    void loadEditions();
  }, [loadEditions]);

  useEffect(() => {
    if (selectedEditionId && !isOffline) {
      void loadEditionDetail(selectedEditionId);
    } else if (!selectedEditionId) {
      setEditionDetail(null);
    }
  }, [selectedEditionId, isOffline, loadEditionDetail]);

  useEffect(() => {
    if (selectedBookingId && !isOffline) {
      void loadBookingDetail(selectedBookingId);
    }
  }, [selectedBookingId, isOffline, loadBookingDetail]);

  const openCreateEdition = () => {
    setEditingEdition(null);
    setEdEventId(eventOptions[0]?.id ?? '');
    setEdProgramme(CRM_PROGRAMMES[0]?.slug ?? 'tribal-habitat-workshop');
    setEdTitle('');
    setEdCapacity('');
    setEdHoldMinutes('');
    setEdMaxGroup('');
    setEdConfirmBeforePayment('unset');
    setEdRequiresScreening(false);
    setEdScreeningQs('');
    setEdCancelPolicy('');
    setEdPriceLabel('Standard');
    setEdPriceMajor('');
    setEdSessionDates('');
    setEdState('open');
    setEditionModalOpen(true);
  };

  const openEditEdition = (ed: CrmEditionDto) => {
    setEditingEdition(ed);
    setEdEventId(ed.eventRecordId);
    setEdProgramme(ed.programmeSlug);
    setEdTitle(ed.title);
    setEdCapacity(ed.capacity !== null ? String(ed.capacity) : '');
    setEdHoldMinutes(ed.holdMinutes !== null ? String(ed.holdMinutes) : '');
    setEdMaxGroup(ed.maxGroupSize !== null ? String(ed.maxGroupSize) : '');
    setEdConfirmBeforePayment(
      ed.confirmBeforePayment === null ? 'unset' : ed.confirmBeforePayment ? 'yes' : 'no',
    );
    setEdRequiresScreening(ed.requiresScreening);
    setEdScreeningQs(ed.screeningQuestions.join('\n'));
    setEdCancelPolicy(ed.cancellationPolicyText ?? '');
    const firstOpt = ed.priceOptions[0];
    setEdPriceLabel(firstOpt?.label ?? 'Standard');
    setEdPriceMajor(firstOpt ? String(firstOpt.amountMinor / 100) : '');
    setEdSessionDates(ed.sessionDates.join(', '));
    setEdState(ed.state);
    setEditionModalOpen(true);
  };

  const handleSaveEdition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    const eventRecordId = edEventId.trim();
    if (!eventRecordId || !edTitle.trim()) {
      setError('Select or enter an Event record and Edition title.');
      return;
    }
    const priceNum = edPriceMajor.trim() ? Math.round(Number(edPriceMajor) * 100) : null;
    const priceOptions =
      priceNum !== null && Number.isFinite(priceNum) && priceNum >= 0
        ? [{ id: 'standard', label: edPriceLabel.trim() || 'Standard', amountMinor: priceNum, currency: 'INR', active: true }]
        : editingEdition?.priceOptions ?? [];
    const sessionDates = edSessionDates
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    const screeningQuestions = edScreeningQs
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await upsertEdition({
        ...(editingEdition ? { editionId: editingEdition.id, expectedRev: editingEdition.rev } : {}),
        eventRecordId,
        programmeSlug: edProgramme,
        title: edTitle.trim(),
        capacity: edCapacity.trim() ? Number(edCapacity) : null,
        holdMinutes: edHoldMinutes.trim() ? Number(edHoldMinutes) : null,
        maxGroupSize: edMaxGroup.trim() ? Number(edMaxGroup) : null,
        confirmBeforePayment:
          edConfirmBeforePayment === 'unset' ? null : edConfirmBeforePayment === 'yes',
        requiresScreening: edRequiresScreening,
        screeningQuestions,
        cancellationPolicyText: edCancelPolicy.trim() || null,
        priceOptions,
        sessionDates,
        state: edState,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setEditionModalOpen(false);
      setNotice(`Saved edition "${res.result.edition.title}".`);
      await loadEditions();
      setSelectedEditionId(res.result.edition.id);
      navigate(`/crm/bookings/${res.result.edition.id}`, { replace: true });
      await loadEditionDetail(res.result.edition.id);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editionDetail) return;
    const personId = bkPersonId.trim();
    const seats = Math.max(1, Number(bkSeats) || 1);
    const participantNames = bkParticipantNames
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!personId) {
      setError('Select a booker person.');
      return;
    }

    if (isOffline) {
      const personName = peopleOptions.find((p) => p.id === personId)?.title ?? personId;
      saveOfflineBookingIntent(uid, {
        editionId: editionDetail.edition.id,
        editionTitle: editionDetail.edition.title,
        bookerPersonId: personId,
        bookerName: personName,
        seats,
        priceOptionId: bkPriceOptionId || null,
        participantNames,
        notes: bkNotes.trim() || null,
      });
      setOfflineIntents(listOfflineBookingIntents(uid));
      setBookingModalOpen(false);
      setNotice('Saved locally as an unconfirmed booking request. Seats are never held or confirmed offline.');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await requestBooking({
        editionId: editionDetail.edition.id,
        bookerPersonId: personId,
        seats,
        priceOptionId: bkPriceOptionId || editionDetail.edition.priceOptions[0]?.id || null,
        participantNames: participantNames.length ? participantNames : undefined,
        preferWaitlist: bkPreferWaitlist,
        source: 'crm',
        notes: bkNotes.trim() || null,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setBookingModalOpen(false);
      setBkParticipantNames('');
      setBkNotes('');
      setNotice(`Booking created (${res.result.booking.state}).`);
      await loadEditions();
      await loadEditionDetail(editionDetail.edition.id);
      setSelectedBookingId(res.result.booking.id);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitOfflineIntent = async (intent: OfflineBookingRequestIntent) => {
    if (isOffline || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await requestBooking(
        {
          editionId: intent.editionId,
          bookerPersonId: intent.bookerPersonId,
          seats: intent.seats,
          priceOptionId: intent.priceOptionId,
          participantNames: intent.participantNames.length ? intent.participantNames : undefined,
          source: 'crm_offline_intent',
          notes: intent.notes,
        },
        { requestId: intent.id },
      );
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      removeOfflineBookingIntent(uid, intent.id);
      setOfflineIntents(listOfflineBookingIntents(uid));
      setNotice(`Submitted offline request for ${intent.bookerName} (${res.result.booking.state}).`);
      await loadEditions();
      if (selectedEditionId === intent.editionId) await loadEditionDetail(intent.editionId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const runBookingTransition = async (
    label: string,
    fn: () => Promise<{ ok: true; result: { booking: CrmBookingDto } } | { ok: false; error: string; detail?: Record<string, unknown> }>,
  ) => {
    if (busy || isOffline) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setNotice(`${label}: state is now ${res.result.booking.state}.`);
      setCancelReason('');
      await loadEditions();
      if (selectedEditionId) await loadEditionDetail(selectedEditionId);
      if (selectedBookingId) await loadBookingDetail(selectedBookingId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveParticipant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingParticipant || !partNameDraft.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await updateParticipant({
        participantId: editingParticipant.id,
        displayName: partNameDraft.trim(),
        personId: partPersonDraft || null,
        expectedRev: editingParticipant.rev,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setEditingParticipant(null);
      setNotice(`Updated participant "${res.result.participant.displayName}".`);
      if (selectedEditionId) await loadEditionDetail(selectedEditionId);
      if (selectedBookingId) await loadBookingDetail(selectedBookingId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRecordAttendance = async (participantId: string, sessionDate: string, state: 'present' | 'absent' | 'partial') => {
    if (busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await recordAttendance({ participantId, sessionDate, state });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setNotice(`Recorded ${state} for ${sessionDate}.`);
      if (selectedEditionId) await loadEditionDetail(selectedEditionId);
      if (selectedBookingId) await loadBookingDetail(selectedBookingId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveScreening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!screeningParticipantId || !screeningAnswerText.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const qKey = screeningData?.questions[0] ?? 'Screening response';
      const res = await upsertScreening({
        participantId: screeningParticipantId,
        answers: { [qKey]: screeningAnswerText.trim() },
        state: 'received',
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setScreeningAnswerText('');
      setNotice('Recorded restricted screening response.');
      if (selectedBookingId) await loadBookingDetail(selectedBookingId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReviewScreening = async (participantId: string, expectedRev: number) => {
    if (!screeningReviewNote.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await reviewScreening({
        participantId,
        state: screeningReviewState as 'reviewed' | 'cleared' | 'not_suitable',
        reviewNote: screeningReviewNote.trim(),
        expectedRev,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setScreeningReviewNote('');
      setNotice(`Screening marked ${res.result.screening.state}.`);
      if (selectedBookingId) await loadBookingDetail(selectedBookingId);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteEdition = async () => {
    if (!editionDetail || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await completeEdition({
        editionId: editionDetail.edition.id,
        expectedRev: editionDetail.edition.rev,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setNotice(
        `Edition completed (${res.result.completedBookings} confirmed booking${res.result.completedBookings === 1 ? '' : 's'} closed; unrecorded attendance slots explicitly marked not_recorded).`,
      );
      await loadEditions();
      await loadEditionDetail(editionDetail.edition.id);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const activeEdition = editionDetail?.edition ?? null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Operations · S6</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Editions &amp; Bookings</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading || isOffline}
            onClick={() => {
              void loadEditions();
              if (selectedEditionId) void loadEditionDetail(selectedEditionId);
            }}
            className="crm-btn-secondary min-h-11"
          >
            <RefreshCw size={14} aria-hidden="true" className={loading || detailLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          {canConfigure && (
            <button
              type="button"
              disabled={isOffline}
              onClick={openCreateEdition}
              className="crm-btn-primary min-h-11"
            >
              <Plus size={15} aria-hidden="true" />
              <span>Configure edition</span>
            </button>
          )}
        </div>
      </header>

      {isOffline && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border px-4 py-3 text-xs"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            borderColor: 'var(--crm-warn-border)',
            color: 'var(--crm-warn-text)',
          }}
        >
          <CloudOff size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Offline mode — seat holds and confirmations require a server connection</p>
            <p className="mt-0.5">
              You can save a local booking request below; it will stay clearly marked &ldquo;Request, not confirmed&rdquo; until submitted online.
            </p>
          </div>
        </div>
      )}

      {offlineIntents.length > 0 && (
        <section aria-label="Unconfirmed local booking requests" className="crm-panel space-y-2.5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Clock size={15} aria-hidden="true" />
            <span>Unconfirmed local booking requests ({offlineIntents.length})</span>
          </h2>
          <ul className="space-y-2">
            {offlineIntents.map((intent) => (
              <li
                key={intent.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-3 py-2 text-xs text-[var(--crm-warn-text)]"
              >
                <div className="min-w-0">
                  <p className="font-semibold">
                    {intent.bookerName} · {intent.seats} seat{intent.seats === 1 ? '' : 's'} · {intent.editionTitle}
                  </p>
                  <p className="text-[11px]">Request, not confirmed — submit when connected to check live capacity.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={isOffline || busy}
                    onClick={() => void submitOfflineIntent(intent)}
                    className="crm-btn-primary !min-h-11 !text-xs"
                  >
                    Submit online
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeOfflineBookingIntent(uid, intent.id);
                      setOfflineIntents(listOfflineBookingIntents(uid));
                    }}
                    className="crm-btn-secondary !min-h-11 !text-xs"
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border px-4 py-3 text-xs"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-3 text-xs font-medium text-[var(--crm-text)]"
        >
          {notice}
        </div>
      )}

      {/* Edition Selector Strip */}
      <section aria-label="Editions" className="crm-panel space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Programme editions ({editions.length})</h2>
          {activeEdition && canConfigure && (
            <button
              type="button"
              disabled={isOffline}
              onClick={() => openEditEdition(activeEdition)}
              className="crm-btn-secondary !min-h-11 !text-xs"
            >
              Edit edition policy
            </button>
          )}
        </div>
        {editions.length === 0 ? (
          <p className="text-xs text-[var(--crm-text-muted)]">
            No editions configured yet. Configure an edition linked to an Event record (capacity, hold duration, max group size, and confirmation policy are explicitly configured per edition — pending O-05).
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {editions.map((ed) => {
              const selected = ed.id === selectedEditionId;
              const badge = stateBadgeStyle(ed.state);
              return (
                <button
                  key={ed.id}
                  type="button"
                  onClick={() => {
                    setSelectedEditionId(ed.id);
                    navigate(`/crm/bookings/${ed.id}`, { replace: true });
                  }}
                  className={`flex min-h-11 flex-col items-start gap-1.5 rounded-lg border p-3 text-left text-xs transition-colors ${
                    selected
                      ? 'border-[var(--crm-primary)] bg-[var(--crm-primary-soft)]'
                      : 'border-[var(--crm-border)] bg-[var(--crm-bg)] hover:bg-[var(--crm-surface-2)]'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate font-semibold text-[var(--crm-text)]">{ed.title}</span>
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                      style={{ backgroundColor: badge.bg, color: badge.fg }}
                    >
                      {ed.state}
                    </span>
                  </div>
                  <p className="text-[var(--crm-text-muted)]">
                    {ed.programmeSlug} ·{' '}
                    {ed.capacity !== null
                      ? `${ed.confirmedSeats} confirmed · ${ed.heldSeats} held · ${ed.availableSeats ?? 0} free`
                      : 'Policy unconfigured (O-05)'}
                  </p>
                  {ed.requiresScreening && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--crm-primary)]">
                      <Lock size={11} aria-hidden="true" />
                      <span>Restricted screening required</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Active Edition Detail & Bookings */}
      {activeEdition && editionDetail && (
        <section aria-label="Selected edition bookings" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
            <div className="crm-panel p-3.5">
              <span className="text-[var(--crm-text-muted)]">Capacity</span>
              <p className="crm-tabular mt-1 text-lg font-semibold">
                {activeEdition.capacity ?? 'Unset'}
              </p>
            </div>
            <div className="crm-panel p-3.5">
              <span className="text-[var(--crm-text-muted)]">Confirmed / Held</span>
              <p className="crm-tabular mt-1 text-lg font-semibold">
                {activeEdition.confirmedSeats} / {activeEdition.heldSeats}
              </p>
            </div>
            <div className="crm-panel p-3.5">
              <span className="text-[var(--crm-text-muted)]">Available seats</span>
              <p className="crm-tabular mt-1 text-lg font-semibold">
                {activeEdition.availableSeats ?? '—'}
              </p>
            </div>
            <div className="crm-panel p-3.5">
              <span className="text-[var(--crm-text-muted)]">Waitlist</span>
              <p className="crm-tabular mt-1 text-lg font-semibold">{activeEdition.waitlistedCount}</p>
            </div>
          </div>

          <div className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
            <div className="space-y-1">
              <p className="font-semibold text-[var(--crm-text)]">
                {activeEdition.title} · Hold {activeEdition.holdMinutes ?? 'unset'}m · Max group {activeEdition.maxGroupSize ?? 'unset'} ·{' '}
                {activeEdition.confirmBeforePayment === null
                  ? 'Confirm policy unset (O-05)'
                  : activeEdition.confirmBeforePayment
                    ? 'Confirm before payment allowed'
                    : 'Payment required before confirm'}
              </p>
              {activeEdition.cancellationPolicyText && (
                <p className="text-[var(--crm-text-muted)]">Cancellation policy: {activeEdition.cancellationPolicyText}</p>
              )}
              {activeEdition.sessionDates.length > 0 && (
                <p className="text-[var(--crm-text-muted)]">
                  Sessions: {activeEdition.sessionDates.join(', ')}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setBkPersonId(peopleOptions[0]?.id ?? '');
                  setBkPriceOptionId(activeEdition.priceOptions[0]?.id ?? '');
                  setBkSeats('1');
                  setBkPreferWaitlist(false);
                  setBookingModalOpen(true);
                }}
                className="crm-btn-primary min-h-11"
              >
                <Ticket size={15} aria-hidden="true" />
                <span>{isOffline ? 'Draft offline request' : 'New booking request'}</span>
              </button>
              {canConfigure && activeEdition.state !== 'completed' && (
                <button
                  type="button"
                  disabled={busy || isOffline}
                  onClick={() => void handleCompleteEdition()}
                  className="crm-btn-secondary min-h-11"
                >
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>Complete edition</span>
                </button>
              )}
            </div>
          </div>

          {editionDetail.bookings.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No bookings in this edition yet.
            </div>
          ) : layout === 'compact' ? (
            <ul className="space-y-2.5">
              {editionDetail.bookings.map((bk) => {
                const badge = stateBadgeStyle(bk.effectiveState);
                return (
                  <li key={bk.id} className="crm-panel space-y-2 p-4 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{bk.bookerName ?? bk.bookerPersonId}</p>
                        <p className="text-[var(--crm-text-muted)]">
                          {bk.seats} seat{bk.seats === 1 ? '' : 's'} · Payment: {bk.paymentStatus.replace(/_/g, ' ')}
                        </p>
                      </div>
                      <span
                        className="shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase"
                        style={{ backgroundColor: badge.bg, color: badge.fg }}
                      >
                        {bk.effectiveState.replace(/_/g, ' ')}
                      </span>
                    </div>
                    {bk.effectiveState === 'paid_without_seat' && (
                      <p className="rounded border border-[var(--crm-err-border)] bg-[var(--crm-err-bg)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--crm-err-text)]">
                        Paid without seat — review for transfer or refund!
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedBookingId(bk.id)}
                      className="crm-btn-secondary w-full min-h-11"
                    >
                      Manage booking, participants &amp; attendance
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="crm-table-wrap" role="region" aria-label="Edition bookings" tabIndex={0}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th scope="col" className="crm-sticky-col">Booker</th>
                    <th scope="col">Seats</th>
                    <th scope="col">State</th>
                    <th scope="col">Payment</th>
                    <th scope="col">Price</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {editionDetail.bookings.map((bk) => {
                    const badge = stateBadgeStyle(bk.effectiveState);
                    return (
                      <tr key={bk.id}>
                        <td className="crm-sticky-col">
                          <div className="font-semibold">{bk.bookerName ?? bk.bookerPersonId}</div>
                          <div className="text-[11px] text-[var(--crm-text-muted)]">{bk.id}</div>
                        </td>
                        <td className="crm-tabular">{bk.seats}</td>
                        <td>
                          <span
                            className="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase"
                            style={{ backgroundColor: badge.bg, color: badge.fg }}
                          >
                            {bk.effectiveState.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="capitalize">{bk.paymentStatus.replace(/_/g, ' ')}</td>
                        <td className="crm-tabular">
                          {bk.unitAmountMinor !== null && bk.currency
                            ? formatMinorMoney(bk.unitAmountMinor * bk.seats, bk.currency)
                            : '—'}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setSelectedBookingId(bk.id)}
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Configure Edition Dialog */}
      {editionModalOpen && (
        <AdaptiveDialog
          title={editingEdition ? `Edit edition: ${editingEdition.title}` : 'Configure edition'}
          onClose={() => setEditionModalOpen(false)}
        >
          <form onSubmit={(e) => void handleSaveEdition(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Event record</span>
              {eventOptions.length > 0 ? (
                <select
                  className="crm-select min-h-11"
                  value={edEventId}
                  onChange={(e) => setEdEventId(e.target.value)}
                  disabled={Boolean(editingEdition)}
                >
                  <option value="">Select Event record…</option>
                  {eventOptions.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="crm-input min-h-11"
                  placeholder="Event record ID"
                  value={edEventId}
                  onChange={(e) => setEdEventId(e.target.value)}
                  disabled={Boolean(editingEdition)}
                />
              )}
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Programme</span>
                <select className="crm-select min-h-11" value={edProgramme} onChange={(e) => setEdProgramme(e.target.value)}>
                  {CRM_PROGRAMMES.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">State</span>
                <select
                  className="crm-select min-h-11"
                  value={edState}
                  onChange={(e) => setEdState(e.target.value as EditionState)}
                >
                  <option value="draft">Draft</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="font-medium">Edition title</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={edTitle}
                onChange={(e) => setEdTitle(e.target.value)}
                placeholder="e.g. Autumn Cohort 2026"
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              <label className="block space-y-1">
                <span className="font-medium">Capacity</span>
                <input
                  type="number"
                  min={1}
                  className="crm-input min-h-11"
                  value={edCapacity}
                  onChange={(e) => setEdCapacity(e.target.value)}
                  placeholder="Unset"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Hold (min)</span>
                <input
                  type="number"
                  min={1}
                  className="crm-input min-h-11"
                  value={edHoldMinutes}
                  onChange={(e) => setEdHoldMinutes(e.target.value)}
                  placeholder="Unset"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Max group</span>
                <input
                  type="number"
                  min={1}
                  className="crm-input min-h-11"
                  value={edMaxGroup}
                  onChange={(e) => setEdMaxGroup(e.target.value)}
                  placeholder="Unset"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="font-medium">Confirm before payment policy (O-05)</span>
              <select
                className="crm-select min-h-11"
                value={edConfirmBeforePayment}
                onChange={(e) => setEdConfirmBeforePayment(e.target.value as 'unset' | 'yes' | 'no')}
              >
                <option value="unset">Unconfigured (blocks booking until configured)</option>
                <option value="no">Payment required before confirm</option>
                <option value="yes">Allow confirm before payment</option>
              </select>
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Price option label</span>
                <input
                  type="text"
                  className="crm-input min-h-11"
                  value={edPriceLabel}
                  onChange={(e) => setEdPriceLabel(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Amount (INR)</span>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className="crm-input min-h-11"
                  value={edPriceMajor}
                  onChange={(e) => setEdPriceMajor(e.target.value)}
                  placeholder="e.g. 2500"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="font-medium">Session dates (YYYY-MM-DD, comma separated)</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={edSessionDates}
                onChange={(e) => setEdSessionDates(e.target.value)}
                placeholder="2026-12-05, 2026-12-06"
              />
            </label>

            <label className="flex min-h-11 items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={edRequiresScreening}
                onChange={(e) => setEdRequiresScreening(e.target.checked)}
              />
              <span>Requires programme-scoped restricted screening</span>
            </label>

            {edRequiresScreening && (
              <label className="block space-y-1">
                <span className="font-medium">Screening questions (one per line)</span>
                <textarea
                  rows={2}
                  className="crm-input"
                  value={edScreeningQs}
                  onChange={(e) => setEdScreeningQs(e.target.value)}
                />
              </label>
            )}

            <label className="block space-y-1">
              <span className="font-medium">Cancellation policy text (O-06)</span>
              <textarea
                rows={2}
                className="crm-input"
                value={edCancelPolicy}
                onChange={(e) => setEdCancelPolicy(e.target.value)}
              />
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditionModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Save edition
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* New Booking Request Dialog */}
      {bookingModalOpen && activeEdition && (
        <AdaptiveDialog
          title={isOffline ? 'Draft offline booking request (unconfirmed)' : `New booking: ${activeEdition.title}`}
          onClose={() => setBookingModalOpen(false)}
        >
          <form onSubmit={(e) => void handleRequestBooking(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Booker</span>
              {peopleOptions.length > 0 ? (
                <select className="crm-select min-h-11" value={bkPersonId} onChange={(e) => setBkPersonId(e.target.value)}>
                  <option value="">Select person…</option>
                  {peopleOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="crm-input min-h-11"
                  value={bkPersonId}
                  onChange={(e) => setBkPersonId(e.target.value)}
                  placeholder="Person record ID"
                />
              )}
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Seats</span>
                <input
                  type="number"
                  min={1}
                  max={activeEdition.maxGroupSize ?? 50}
                  className="crm-input min-h-11"
                  value={bkSeats}
                  onChange={(e) => setBkSeats(e.target.value)}
                />
              </label>
              {activeEdition.priceOptions.length > 0 && (
                <label className="block space-y-1">
                  <span className="font-medium">Price option</span>
                  <select
                    className="crm-select min-h-11"
                    value={bkPriceOptionId}
                    onChange={(e) => setBkPriceOptionId(e.target.value)}
                  >
                    {activeEdition.priceOptions.map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.label} ({formatMinorMoney(po.amountMinor, po.currency)})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <label className="block space-y-1">
              <span className="font-medium">Named participants (optional, one per line; remaining seats become placeholders)</span>
              <textarea
                rows={3}
                className="crm-input"
                value={bkParticipantNames}
                onChange={(e) => setBkParticipantNames(e.target.value)}
                placeholder="Leave blank to create placeholders"
              />
            </label>

            {!isOffline && (
              <label className="flex min-h-11 items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={bkPreferWaitlist}
                  onChange={(e) => setBkPreferWaitlist(e.target.checked)}
                />
                <span>Join waitlist immediately if edition is full</span>
              </label>
            )}

            <label className="block space-y-1">
              <span className="font-medium">Notes</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={bkNotes}
                onChange={(e) => setBkNotes(e.target.value)}
              />
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setBookingModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                {isOffline ? 'Save unconfirmed draft' : 'Create booking request'}
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Booking Detail / Participants / Attendance / Restricted Screening Dialog */}
      {selectedBookingId && (
        <AdaptiveDialog
          title={
            bookingDetail
              ? `Booking · ${bookingDetail.booking.bookerName ?? bookingDetail.booking.bookerPersonId}`
              : 'Booking detail'
          }
          onClose={() => {
            setSelectedBookingId(null);
            setBookingDetail(null);
            setScreeningData(null);
            setEditingParticipant(null);
          }}
        >
          <div data-app="crm" className="space-y-4 p-1 text-xs">
            {bookingDetailLoading || !bookingDetail ? (
              <p className="text-[var(--crm-text-muted)]">Loading booking detail…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
                  <div>
                    <p className="font-semibold">
                      State: <span className="uppercase">{bookingDetail.booking.effectiveState.replace(/_/g, ' ')}</span>
                    </p>
                    <p className="text-[var(--crm-text-muted)]">
                      {bookingDetail.booking.seats} seat{bookingDetail.booking.seats === 1 ? '' : 's'} · Payment:{' '}
                      {bookingDetail.booking.paymentStatus.replace(/_/g, ' ')}
                    </p>
                  </div>
                  {bookingDetail.canReadMoney && (
                    <Link to="/crm/money" className="crm-btn-secondary !min-h-11 !text-xs">
                      Open Money &amp; Ledger
                    </Link>
                  )}
                </div>

                {bookingDetail.booking.effectiveState === 'paid_without_seat' && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-[var(--crm-err-border)] bg-[var(--crm-err-bg)] p-3 text-[var(--crm-err-text)]"
                  >
                    <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold">Paid without seat — staff review required</p>
                      <p className="mt-0.5">
                        A payment was recorded after the hold expired. Transfer this booking to an open edition or request an approved refund in Money.
                      </p>
                    </div>
                  </div>
                )}

                {/* Workflow transitions */}
                <div className="flex flex-wrap gap-2">
                  {(bookingDetail.booking.effectiveState === 'request' ||
                    bookingDetail.booking.effectiveState === 'expired') && (
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() =>
                        void runBookingTransition('Hold seat', () =>
                          holdBooking({
                            bookingId: bookingDetail.booking.id,
                            expectedRev: bookingDetail.booking.rev,
                          }),
                        )
                      }
                      className="crm-btn-primary min-h-11"
                    >
                      Hold seat(s)
                    </button>
                  )}
                  {(bookingDetail.booking.effectiveState === 'held' ||
                    bookingDetail.booking.effectiveState === 'awaiting_payment' ||
                    bookingDetail.booking.effectiveState === 'request') && (
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() =>
                        void runBookingTransition('Confirm booking', () =>
                          confirmBooking({
                            bookingId: bookingDetail.booking.id,
                            expectedRev: bookingDetail.booking.rev,
                          }),
                        )
                      }
                      className="crm-btn-primary min-h-11"
                    >
                      <CheckCircle2 size={14} aria-hidden="true" />
                      <span>Confirm</span>
                    </button>
                  )}
                  {bookingDetail.booking.effectiveState === 'waitlisted' && (
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() =>
                        void runBookingTransition('Offer waitlist seat', () =>
                          offerWaitlist({
                            bookingId: bookingDetail.booking.id,
                            expectedRev: bookingDetail.booking.rev,
                          }),
                        )
                      }
                      className="crm-btn-primary min-h-11"
                    >
                      Offer seat from waitlist
                    </button>
                  )}
                  {bookingDetail.booking.effectiveState === 'offered' && (
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() =>
                        void runBookingTransition('Accept waitlist offer', () =>
                          acceptWaitlistOffer({
                            bookingId: bookingDetail.booking.id,
                            expectedRev: bookingDetail.booking.rev,
                          }),
                        )
                      }
                      className="crm-btn-primary min-h-11"
                    >
                      Accept waitlist offer
                    </button>
                  )}
                </div>

                {/* Transfer edition */}
                {editions.length > 1 && bookingDetail.booking.effectiveState !== 'cancelled' && (
                  <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--crm-border)] p-3">
                    <label className="min-w-0 flex-1 space-y-1">
                      <span className="font-medium">Transfer to edition</span>
                      <select
                        className="crm-select min-h-11"
                        value={transferTargetId}
                        onChange={(e) => setTransferTargetId(e.target.value)}
                      >
                        <option value="">Choose target edition…</option>
                        {editions
                          .filter((e) => e.id !== bookingDetail.edition.id && e.state === 'open')
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.title} ({e.availableSeats ?? 0} free)
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!transferTargetId || busy || isOffline}
                      onClick={() =>
                        void runBookingTransition('Transfer booking', () =>
                          transferBooking({
                            bookingId: bookingDetail.booking.id,
                            targetEditionId: transferTargetId,
                            expectedRev: bookingDetail.booking.rev,
                          }),
                        )
                      }
                      className="crm-btn-secondary min-h-11"
                    >
                      <ArrowRightLeft size={14} aria-hidden="true" />
                      <span>Transfer</span>
                    </button>
                  </div>
                )}

                {/* Cancel booking */}
                {bookingDetail.booking.effectiveState !== 'cancelled' &&
                  bookingDetail.booking.effectiveState !== 'completed' && (
                    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--crm-border)] p-3">
                      <label className="min-w-0 flex-1 space-y-1">
                        <span className="font-medium">Cancel reason</span>
                        <input
                          type="text"
                          className="crm-input min-h-11"
                          value={cancelReason}
                          onChange={(e) => setCancelReason(e.target.value)}
                          placeholder="Reason for cancellation"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!cancelReason.trim() || busy || isOffline}
                        onClick={() =>
                          void runBookingTransition('Cancel booking', () =>
                            cancelBooking({
                              bookingId: bookingDetail.booking.id,
                              reason: cancelReason.trim(),
                              expectedRev: bookingDetail.booking.rev,
                            }),
                          )
                        }
                        className="crm-btn-secondary min-h-11"
                      >
                        <XCircle size={14} aria-hidden="true" />
                        <span>Cancel booking</span>
                      </button>
                    </div>
                  )}

                {/* Participants & Attendance */}
                <div className="space-y-2">
                  <h3 className="flex items-center gap-1.5 font-semibold">
                    <Users size={14} aria-hidden="true" />
                    <span>Participants ({bookingDetail.participants.length})</span>
                  </h3>
                  <ul className="space-y-2">
                    {bookingDetail.participants.map((part) => (
                      <li key={part.id} className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-semibold">{part.displayName}</p>
                            <p className="text-[11px] text-[var(--crm-text-muted)]">
                              {part.state === 'placeholder' ? 'Placeholder seat — name later' : 'Named participant'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingParticipant(part);
                              setPartNameDraft(part.displayName);
                              setPartPersonDraft(part.personId ?? '');
                            }}
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            <UserCheck size={13} aria-hidden="true" />
                            <span>{part.state === 'placeholder' ? 'Name participant' : 'Edit'}</span>
                          </button>
                        </div>

                        {bookingDetail.edition.sessionDates.length > 0 && (
                          <div className="space-y-1.5 border-t border-[var(--crm-border)] pt-2">
                            <p className="flex items-center gap-1 text-[11px] font-medium text-[var(--crm-text-muted)]">
                              <Calendar size={12} aria-hidden="true" />
                              <span>Attendance by session date</span>
                            </p>
                            {bookingDetail.edition.sessionDates.map((sd) => {
                              const currentAtt = bookingDetail.attendance.find(
                                (a) => a.participantId === part.id && a.sessionDate === sd,
                              );
                              const curState: AttendanceState | null = currentAtt?.state ?? null;
                              return (
                                <div key={sd} className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="crm-tabular font-medium">
                                    {sd}: <span className="text-[var(--crm-text-muted)]">{curState ?? 'unrecorded'}</span>
                                  </span>
                                  <div className="flex flex-wrap gap-1">
                                    {(['present', 'partial', 'absent'] as const).map((st) => (
                                      <button
                                        key={st}
                                        type="button"
                                        disabled={busy || isOffline}
                                        onClick={() => void handleRecordAttendance(part.id, sd, st)}
                                        className={`min-h-11 rounded border px-2.5 text-[11px] font-medium capitalize ${
                                          curState === st
                                            ? 'border-[var(--crm-primary)] bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]'
                                            : 'border-[var(--crm-border)] bg-[var(--crm-surface)]'
                                        }`}
                                      >
                                        {st}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Inline Name Participant Form */}
                {editingParticipant && (
                  <form
                    onSubmit={(e) => void handleSaveParticipant(e)}
                    className="space-y-2 rounded-lg border border-[var(--crm-primary)] bg-[var(--crm-surface)] p-3"
                  >
                    <p className="font-semibold">Name participant: {editingParticipant.displayName}</p>
                    <input
                      type="text"
                      required
                      className="crm-input min-h-11"
                      value={partNameDraft}
                      onChange={(e) => setPartNameDraft(e.target.value)}
                      placeholder="Full name"
                    />
                    {peopleOptions.length > 0 && (
                      <select
                        className="crm-select min-h-11"
                        value={partPersonDraft}
                        onChange={(e) => setPartPersonDraft(e.target.value)}
                      >
                        <option value="">Optional: link existing Person record…</option>
                        {peopleOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingParticipant(null)}
                        className="crm-btn-secondary min-h-11"
                      >
                        Cancel
                      </button>
                      <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                        Save participant
                      </button>
                    </div>
                  </form>
                )}

                {/* Restricted Screening Section — strictly gated by server `canReadScreening` */}
                {bookingDetail.edition.requiresScreening && (
                  <div className="space-y-2 rounded-lg border border-[var(--crm-border)] p-3">
                    <h3 className="flex items-center gap-1.5 font-semibold">
                      <ShieldAlert size={14} aria-hidden="true" />
                      <span>Restricted screening ({bookingDetail.edition.programmeSlug})</span>
                    </h3>
                    {!bookingDetail.canReadScreening ? (
                      <p className="text-[var(--crm-text-muted)]">
                        Restricted — requires programme-scoped <code>crm.restricted.read</code> capability to view or review screening responses.
                      </p>
                    ) : screeningError ? (
                      <p role="alert" className="text-[var(--crm-err-text)]">
                        {screeningError}
                      </p>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-[11px] text-[var(--crm-text-muted)]">
                          Stored exclusively in server-only restricted screening tables; never synced to Workspace, search, or AI projections.
                        </p>
                        {screeningData?.items.map((scr) => (
                          <div
                            key={scr.participantId}
                            className="space-y-2 rounded border border-[var(--crm-border)] bg-[var(--crm-bg)] p-2.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold">
                                {bookingDetail.participants.find((p) => p.id === scr.participantId)?.displayName ??
                                  scr.participantId}
                              </span>
                              <span className="rounded-full bg-[var(--crm-primary-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--crm-primary)]">
                                {scr.state.replace(/_/g, ' ')}
                              </span>
                            </div>
                            {Object.entries(scr.answers).map(([q, a]) => (
                              <p key={q}>
                                <span className="font-medium">{q}:</span> {a}
                              </p>
                            ))}
                            {scr.reviewNote && (
                              <p className="text-[11px] text-[var(--crm-text-muted)]">Review note: {scr.reviewNote}</p>
                            )}
                            <div className="flex flex-wrap gap-2 pt-1">
                              <select
                                aria-label="Screening decision"
                                className="crm-select !w-auto min-h-11"
                                value={screeningReviewState}
                                onChange={(e) => setScreeningReviewState(e.target.value as ScreeningState)}
                              >
                                <option value="reviewed">Reviewed</option>
                                <option value="cleared">Cleared</option>
                                <option value="not_suitable">Not suitable</option>
                              </select>
                              <input
                                type="text"
                                className="crm-input min-h-11 flex-1"
                                placeholder="Review note"
                                value={screeningReviewNote}
                                onChange={(e) => setScreeningReviewNote(e.target.value)}
                              />
                              <button
                                type="button"
                                disabled={!screeningReviewNote.trim() || busy || isOffline}
                                onClick={() => void handleReviewScreening(scr.participantId, scr.rev)}
                                className="crm-btn-primary min-h-11"
                              >
                                Record review
                              </button>
                            </div>
                          </div>
                        ))}

                        <form onSubmit={(e) => void handleSaveScreening(e)} className="space-y-2 border-t border-[var(--crm-border)] pt-2">
                          <p className="font-medium">Record screening response</p>
                          <select
                            className="crm-select min-h-11"
                            value={screeningParticipantId}
                            onChange={(e) => setScreeningParticipantId(e.target.value)}
                          >
                            <option value="">Select participant…</option>
                            {bookingDetail.participants.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.displayName}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            className="crm-input min-h-11"
                            placeholder={screeningData?.questions[0] ?? 'Screening response'}
                            value={screeningAnswerText}
                            onChange={(e) => setScreeningAnswerText(e.target.value)}
                          />
                          <button
                            type="submit"
                            disabled={!screeningParticipantId || !screeningAnswerText.trim() || busy || isOffline}
                            className="crm-btn-secondary min-h-11"
                          >
                            Save restricted screening
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </AdaptiveDialog>
      )}
    </div>
  );
}
