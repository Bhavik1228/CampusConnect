import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requireSupabase } from './supabase';

export type RecoverableDraftEntity = 'assessment' | 'lesson_plan' | 'report_comment' | 'website_content';
export type DraftSaveState = 'loading' | 'saved' | 'saved_local' | 'saving' | 'offline' | 'conflict' | 'error';

export type DraftEnvelope<T> = {
  userId: string;
  schoolId: string;
  entity: RecoverableDraftEntity;
  entityId: string;
  formVersion: string;
  payload: T;
  updatedAt: string;
  baseServerUpdatedAt: string | null;
  basePayload: T | null;
  correlationId: string;
};

export type DraftVersion<T> = {
  id: string;
  payload: T;
  created_at: string;
  correlation_id: string;
};

type ServerDraft<T> = {
  id: string;
  payload: T;
  updated_at: string;
  correlation_id: string;
};

type RecoveryCandidate<T> = {
  source: 'device' | 'server' | 'version';
  payload: T;
  updatedAt: string;
  versionId?: string;
};

type Conflict<T> = {
  local: DraftEnvelope<T>;
  server: ServerDraft<T>;
  fields: string[];
};

type DraftEvent = {
  school_id: string;
  user_id: string;
  entity: RecoverableDraftEntity;
  entity_id: string;
  event_type: 'started' | 'completed' | 'failed';
  correlation_id: string;
};

const FORM_VERSION = 'v1';
const DEBOUNCE_MS = 850;

function localKey(envelope: Pick<DraftEnvelope<unknown>, 'userId' | 'schoolId' | 'entity' | 'entityId' | 'formVersion'>) {
  return `campus-connect:draft:${envelope.userId}:${envelope.schoolId}:${envelope.entity}:${envelope.entityId}:${envelope.formVersion}`;
}

function eventQueueKey(userId: string, schoolId: string) {
  return `campus-connect:draft-events:${userId}:${schoolId}`;
}

function correlationId() {
  return crypto.randomUUID();
}

function encode(value: unknown) {
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown) {
  return encode(left) === encode(right);
}

function changedFields(base: unknown, next: unknown): string[] {
  if (!base || typeof base !== 'object' || !next || typeof next !== 'object') {
    return sameValue(base, next) ? [] : ['draft'];
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  return [...keys].filter((key) => !sameValue((base as Record<string, unknown>)[key], (next as Record<string, unknown>)[key]));
}

function mergeDisjoint<T>(base: T | null, local: T, server: T): { payload: T; conflicts: string[] } {
  if (!base || typeof base !== 'object' || Array.isArray(base)
      || !local || typeof local !== 'object' || Array.isArray(local)
      || !server || typeof server !== 'object' || Array.isArray(server)) {
    return { payload: local, conflicts: sameValue(local, base) ? [] : ['draft'] };
  }
  const baseObject = base as Record<string, unknown>;
  const localObject = local as Record<string, unknown>;
  const serverObject = server as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...serverObject };
  const conflicts: string[] = [];
  for (const key of new Set([...Object.keys(baseObject), ...Object.keys(localObject), ...Object.keys(serverObject)])) {
    const localChanged = !sameValue(localObject[key], baseObject[key]);
    const serverChanged = !sameValue(serverObject[key], baseObject[key]);
    if (localChanged && serverChanged && !sameValue(localObject[key], serverObject[key])) {
      conflicts.push(key);
    } else if (localChanged) {
      merged[key] = localObject[key];
    }
  }
  return { payload: merged as T, conflicts };
}

function readEnvelope<T>(key: string) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as DraftEnvelope<T> : null;
  } catch (error) {
    console.error('Could not read the local draft envelope.', error);
    return null;
  }
}

function writeEnvelope<T>(key: string, envelope: DraftEnvelope<T>) {
  localStorage.setItem(key, JSON.stringify(envelope));
}

function queueEvent(event: DraftEvent) {
  const key = eventQueueKey(event.user_id, event.school_id);
  try {
    const pending = JSON.parse(localStorage.getItem(key) ?? '[]') as DraftEvent[];
    pending.push(event);
    localStorage.setItem(key, JSON.stringify(pending.slice(-100)));
  } catch (error) {
    console.error('Could not queue draft lifecycle event.', error);
  }
}

async function flushEvents(userId: string, schoolId: string) {
  const key = eventQueueKey(userId, schoolId);
  let pending: DraftEvent[];
  try {
    pending = JSON.parse(localStorage.getItem(key) ?? '[]') as DraftEvent[];
  } catch (error) {
    console.error('Could not read queued draft lifecycle events.', error);
    return;
  }
  if (!pending.length) return;
  const { error } = await requireSupabase().from('quality_of_life_draft_events').insert(pending);
  if (error) throw error;
  localStorage.removeItem(key);
}

export function useRecoverableDraft<T>({
  schoolId,
  userId,
  entity,
  entityId,
  payload,
  enabled,
}: {
  schoolId?: string;
  userId?: string;
  entity: RecoverableDraftEntity;
  entityId: string;
  payload: T;
  enabled: boolean;
}) {
  const identity = useMemo(() => ({
    schoolId: schoolId ?? '',
    userId: userId ?? '',
    entity,
    entityId,
    formVersion: FORM_VERSION,
  }), [schoolId, userId, entity, entityId]);
  const key = useMemo(() => identity.userId && identity.schoolId ? localKey({
    userId: identity.userId,
    schoolId: identity.schoolId,
    entity: identity.entity,
    entityId: identity.entityId,
    formVersion: identity.formVersion,
  }) : '', [identity]);
  const payloadJson = useMemo(() => encode(payload), [payload]);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const generationRef = useRef(0);
  const syncQueueRef = useRef(Promise.resolve());
  const saveTimerRef = useRef<number | undefined>(undefined);
  const serverReadyRef = useRef(false);
  const serverBaselineRef = useRef<ServerDraft<T> | null>(null);
  const correlationRef = useRef(correlationId());
  const initialPayloadRef = useRef(payloadJson);
  const lastLocallySavedRef = useRef(payloadJson);
  const initializedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<DraftSaveState>('loading');
  const [candidate, setCandidate] = useState<RecoveryCandidate<T> | null>(null);
  const [conflict, setConflict] = useState<Conflict<T> | null>(null);
  const [versions, setVersions] = useState<DraftVersion<T>[]>([]);
  const [restorePreviewOpen, setRestorePreviewOpen] = useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);

  useEffect(() => {
    initialPayloadRef.current = payloadJson;
    lastLocallySavedRef.current = payloadJson;
  }, [key]);

  const emit = useCallback((eventType: DraftEvent['event_type'], eventCorrelationId: string = correlationRef.current) => {
    if (!identity.userId || !identity.schoolId) return;
    queueEvent({
      school_id: identity.schoolId,
      user_id: identity.userId,
      entity: identity.entity,
      entity_id: identity.entityId,
      event_type: eventType,
      correlation_id: eventCorrelationId,
    });
    if (navigator.onLine) {
      void flushEvents(identity.userId, identity.schoolId).catch((error: unknown) => {
        console.error('Could not sync draft lifecycle events.', error);
      });
    }
  }, [identity]);

  const loadVersions = useCallback(async () => {
    if (!identity.userId || !identity.schoolId) return;
    const { data, error } = await requireSupabase().from('quality_of_life_draft_versions')
      .select('id,payload,created_at,correlation_id')
      .eq('school_id', identity.schoolId)
      .eq('user_id', identity.userId)
      .eq('entity', identity.entity)
      .eq('entity_id', identity.entityId)
      .eq('form_version', identity.formVersion)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    setVersions((data ?? []) as DraftVersion<T>[]);
  }, [identity]);

  const fetchServerDraft = useCallback(async () => {
    if (!identity.userId || !identity.schoolId) return null;
    const { data, error } = await requireSupabase().from('quality_of_life_drafts')
      .select('id,payload,updated_at,correlation_id')
      .eq('school_id', identity.schoolId)
      .eq('user_id', identity.userId)
      .eq('entity', identity.entity)
      .eq('entity_id', identity.entityId)
      .eq('form_version', identity.formVersion)
      .maybeSingle();
    if (error) throw error;
    return data as ServerDraft<T> | null;
  }, [identity]);

  const persistServer = useCallback(async (envelope: DraftEnvelope<T>, expected: ServerDraft<T> | null) => {
    if (!navigator.onLine) {
      setState('offline');
      return;
    }
    setState('saving');
    try {
      const current = expected ?? await fetchServerDraft();
      serverBaselineRef.current = current;
      if (current) {
        if (sameValue(envelope.payload, current.payload)) {
          const latestLocal = readEnvelope<T>(key);
          const savedEnvelope: DraftEnvelope<T> = {
            ...(latestLocal && latestLocal.updatedAt > envelope.updatedAt ? latestLocal : envelope),
            payload: latestLocal && latestLocal.updatedAt > envelope.updatedAt ? latestLocal.payload : current.payload,
            basePayload: current.payload,
            baseServerUpdatedAt: current.updated_at,
          };
          writeEnvelope(key, savedEnvelope);
          lastLocallySavedRef.current = encode(savedEnvelope.payload);
          setState(latestLocal && latestLocal.updatedAt > envelope.updatedAt ? 'saved_local' : 'saved');
          emit('completed', savedEnvelope.correlationId);
          return;
        }
        const base = envelope.basePayload;
        const merged = mergeDisjoint(base, envelope.payload, current.payload);
        const serverMoved = envelope.baseServerUpdatedAt !== current.updated_at;
        if (serverMoved && merged.conflicts.length) {
          setConflict({ local: envelope, server: current, fields: merged.conflicts });
          setCandidate({ source: 'device', payload: envelope.payload, updatedAt: envelope.updatedAt });
          setState('conflict');
          return;
        }
        const nextPayload = serverMoved ? merged.payload : envelope.payload;
        if (sameValue(current.payload, nextPayload)) {
          const latestLocal = readEnvelope<T>(key);
          const hasNewerLocal = Boolean(latestLocal && latestLocal.updatedAt > envelope.updatedAt);
          const nextEnvelope: DraftEnvelope<T> = {
            ...(hasNewerLocal && latestLocal ? latestLocal : envelope),
            payload: hasNewerLocal && latestLocal ? latestLocal.payload : nextPayload,
            basePayload: current.payload,
            baseServerUpdatedAt: current.updated_at,
          };
          writeEnvelope(key, nextEnvelope);
          lastLocallySavedRef.current = encode(nextEnvelope.payload);
          setState(hasNewerLocal ? 'saved_local' : 'saved');
          if (!hasNewerLocal) emit('completed', envelope.correlationId);
          return;
        }
        const { data, error } = await requireSupabase().from('quality_of_life_drafts')
          .update({
            payload: nextPayload,
            correlation_id: envelope.correlationId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', current.id)
          .eq('updated_at', current.updated_at)
          .select('id,payload,updated_at,correlation_id')
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          const latest = await fetchServerDraft();
          if (latest) {
            setConflict({ local: envelope, server: latest, fields: changedFields(current.payload, latest.payload) });
            setCandidate({ source: 'device', payload: envelope.payload, updatedAt: envelope.updatedAt });
            setState('conflict');
            return;
          }
          throw new Error('The saved draft changed in another session. Refresh and review the current copy before continuing.');
        }
        const saved = data as ServerDraft<T>;
        serverBaselineRef.current = saved;
        const latestLocal = readEnvelope<T>(key);
        const hasNewerLocal = Boolean(latestLocal && latestLocal.updatedAt > envelope.updatedAt);
        const savedEnvelope: DraftEnvelope<T> = {
          ...(hasNewerLocal && latestLocal ? latestLocal : envelope),
          payload: hasNewerLocal && latestLocal ? latestLocal.payload : saved.payload,
          basePayload: saved.payload,
          baseServerUpdatedAt: saved.updated_at,
        };
        writeEnvelope(key, savedEnvelope);
        lastLocallySavedRef.current = encode(savedEnvelope.payload);
        setState(hasNewerLocal ? 'saved_local' : 'saved');
        if (!hasNewerLocal) emit('completed', envelope.correlationId);
        await loadVersions().catch((error: unknown) => {
          console.error('Could not refresh draft version history.', error);
        });
      } else {
        const { data, error } = await requireSupabase().from('quality_of_life_drafts')
          .insert({
            school_id: identity.schoolId,
            user_id: identity.userId,
            entity: identity.entity,
            entity_id: identity.entityId,
            form_version: identity.formVersion,
            payload: envelope.payload,
            correlation_id: envelope.correlationId,
          })
          .select('id,payload,updated_at,correlation_id')
          .single();
        if (error) {
          if (error.code === '23505') {
            const latest = await fetchServerDraft();
            if (latest) {
              setConflict({ local: envelope, server: latest, fields: ['draft'] });
              setCandidate({ source: 'device', payload: envelope.payload, updatedAt: envelope.updatedAt });
              setState('conflict');
              return;
            }
          }
          throw error;
        }
        const saved = data as ServerDraft<T>;
        serverBaselineRef.current = saved;
        const latestLocal = readEnvelope<T>(key);
        const hasNewerLocal = Boolean(latestLocal && latestLocal.updatedAt > envelope.updatedAt);
        const savedEnvelope: DraftEnvelope<T> = {
          ...(hasNewerLocal && latestLocal ? latestLocal : envelope),
          payload: hasNewerLocal && latestLocal ? latestLocal.payload : saved.payload,
          basePayload: saved.payload,
          baseServerUpdatedAt: saved.updated_at,
        };
        writeEnvelope(key, savedEnvelope);
        lastLocallySavedRef.current = encode(savedEnvelope.payload);
        setState(hasNewerLocal ? 'saved_local' : 'saved');
        if (!hasNewerLocal) emit('completed', envelope.correlationId);
        await loadVersions().catch((error: unknown) => {
          console.error('Could not refresh draft version history.', error);
        });
      }
    } catch (error) {
      setState(navigator.onLine ? 'error' : 'offline');
      emit('failed', envelope.correlationId);
      console.error('Could not sync recoverable draft.', error);
    }
  }, [emit, fetchServerDraft, identity, key, loadVersions]);

  const queueServerSync = useCallback(() => {
    const operation = syncQueueRef.current.then(async () => {
      if (!serverReadyRef.current) return;
      const latest = readEnvelope<T>(key);
      if (latest) await persistServer(latest, null);
    });
    syncQueueRef.current = operation.catch((error: unknown) => {
      console.error('Could not process the queued draft sync.', error);
    });
    return operation;
  }, [key, persistServer]);

  useEffect(() => {
    generationRef.current += 1;
    correlationRef.current = correlationId();
    initializedRef.current = false;
    serverReadyRef.current = false;
    serverBaselineRef.current = null;
    setReady(false);
    setCandidate(null);
    setConflict(null);
    setVersions([]);
    if (!enabled || !key || !identity.schoolId || !identity.userId) {
      setState('saved');
      setReady(true);
      return;
    }

    let active = true;
    const generation = generationRef.current;
    let local = readEnvelope<T>(key);
    if (local) {
      lastLocallySavedRef.current = encode(local.payload);
      setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
    } else {
      lastLocallySavedRef.current = initialPayloadRef.current;
    }
    initializedRef.current = true;
    setReady(true);
    setState(local ? 'saved_local' : navigator.onLine ? 'saved' : 'offline');
    if (!navigator.onLine) serverReadyRef.current = true;

    const initialize = async () => {
      if (navigator.onLine) {
        try {
          const server = await fetchServerDraft();
          if (!active || generation !== generationRef.current) return;
          await loadVersions();
          if (!active || generation !== generationRef.current) return;
          serverBaselineRef.current = server;
          local = readEnvelope<T>(key);
          serverReadyRef.current = true;
          if (server && local) {
            if (local.baseServerUpdatedAt === null && !sameValue(local.payload, server.payload)) {
              setConflict({ local, server, fields: ['draft'] });
              setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
              setState('conflict');
            } else if (local.baseServerUpdatedAt && local.baseServerUpdatedAt !== server.updated_at) {
              const merge = mergeDisjoint(local.basePayload, local.payload, server.payload);
              if (merge.conflicts.length) {
                setConflict({ local, server, fields: merge.conflicts });
                setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
                setState('conflict');
              } else {
                const reconciled = { ...local, payload: merge.payload, basePayload: server.payload, baseServerUpdatedAt: server.updated_at };
                writeEnvelope(key, reconciled);
                setCandidate({ source: 'device', payload: merge.payload, updatedAt: local.updatedAt });
                if (!sameValue(merge.payload, server.payload)) void queueServerSync();
              }
            } else if (local.baseServerUpdatedAt === server.updated_at) {
              const reconciled = { ...local, basePayload: server.payload, baseServerUpdatedAt: server.updated_at };
              writeEnvelope(key, reconciled);
              setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
              if (!sameValue(local.payload, server.payload)) void queueServerSync();
            } else if (!sameValue(local.payload, server.payload)) {
              setConflict({ local, server, fields: ['draft'] });
              setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
              setState('conflict');
            } else {
              const reconciled = {
                ...local,
                payload: server.payload,
                basePayload: server.payload,
                baseServerUpdatedAt: server.updated_at,
              };
              writeEnvelope(key, reconciled);
              setCandidate({ source: 'server', payload: server.payload, updatedAt: server.updated_at });
              lastLocallySavedRef.current = encode(server.payload);
            }
          } else if (server) {
            setCandidate({ source: 'server', payload: server.payload, updatedAt: server.updated_at });
            lastLocallySavedRef.current = encode(server.payload);
          } else if (local) {
            setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
            void queueServerSync();
          }
        } catch (error) {
          if (!active || generation !== generationRef.current) return;
          serverReadyRef.current = true;
          setState(navigator.onLine ? 'error' : 'offline');
          if (local) setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
          console.error('Could not check the server draft copy.', error);
        }
      } else if (local) {
        serverReadyRef.current = true;
        setCandidate({ source: 'device', payload: local.payload, updatedAt: local.updatedAt });
        setState('offline');
      } else {
        serverReadyRef.current = true;
      }
      if (!active || generation !== generationRef.current) return;
      setReady(true);
      setState((current) => current === 'loading' ? navigator.onLine ? 'saved' : 'offline' : current);
    };
    void initialize();
    return () => { active = false; };
  }, [enabled, key, identity.schoolId, identity.userId, fetchServerDraft, loadVersions, queueServerSync]);

  useEffect(() => {
    if (!enabled || !ready || !key || !identity.userId || !identity.schoolId || !initializedRef.current) return;
    if (candidate || conflict) return;
    if (payloadJson === lastLocallySavedRef.current) return;
    const timer = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      const envelope: DraftEnvelope<T> = {
        userId: identity.userId,
        schoolId: identity.schoolId,
        entity: identity.entity,
        entityId: identity.entityId,
        formVersion: identity.formVersion,
        payload: payloadRef.current,
        updatedAt: new Date().toISOString(),
        baseServerUpdatedAt: readEnvelope<T>(key)?.baseServerUpdatedAt ?? null,
        basePayload: readEnvelope<T>(key)?.basePayload ?? null,
        correlationId: correlationRef.current,
      };
      try {
        if (lastLocallySavedRef.current === initialPayloadRef.current) emit('started', envelope.correlationId);
        setState('saving');
        writeEnvelope(key, envelope);
        lastLocallySavedRef.current = encode(envelope.payload);
        setState(navigator.onLine ? 'saved_local' : 'offline');
        if (navigator.onLine) void queueServerSync();
      } catch (error) {
        setState('error');
        emit('failed', envelope.correlationId);
        console.error('Could not save recoverable draft locally.', error);
      }
    }, DEBOUNCE_MS);
    saveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (saveTimerRef.current === timer) saveTimerRef.current = undefined;
    };
  }, [enabled, ready, key, identity, payloadJson, emit, queueServerSync, candidate, conflict]);

  useEffect(() => {
    if (!enabled || !identity.userId || !identity.schoolId) return;
    const sync = () => {
      void flushEvents(identity.userId, identity.schoolId).catch((error: unknown) => {
        console.error('Could not sync draft lifecycle events after reconnecting.', error);
      });
      if (!key) return;
      void queueServerSync();
    };
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [enabled, identity.userId, identity.schoolId, queueServerSync]);

  const acceptRestore = useCallback((restore: (value: T) => void, value = candidate?.payload) => {
    if (value === undefined) return;
    const restoredCandidate = candidate;
    restore(value);
    try {
      if (key && identity.userId && identity.schoolId) {
        const local = readEnvelope<T>(key);
        const baseline = serverBaselineRef.current;
        const baseServerUpdatedAt = restoredCandidate?.source === 'server'
          ? restoredCandidate.updatedAt
          : local?.baseServerUpdatedAt ?? baseline?.updated_at ?? null;
        const basePayload = restoredCandidate?.source === 'server'
          ? restoredCandidate.payload
          : local?.basePayload ?? baseline?.payload ?? null;
        writeEnvelope(key, {
          userId: identity.userId,
          schoolId: identity.schoolId,
          entity: identity.entity,
          entityId: identity.entityId,
          formVersion: identity.formVersion,
          payload: value,
          updatedAt: new Date().toISOString(),
          baseServerUpdatedAt,
          basePayload,
          correlationId: correlationRef.current,
        });
      }
    } catch (error) {
      setState('error');
      emit('failed');
      console.error('Could not retain the restored draft on this device.', error);
      return;
    }
    setRestorePreviewOpen(false);
    setCandidate(null);
    setConflict(null);
    initialPayloadRef.current = encode(value);
    lastLocallySavedRef.current = encode(value);
    setState('saved');
  }, [candidate, emit, identity, key]);

  const resolveConflict = useCallback(async (choice: 'use-device' | 'use-server', restore: (value: T) => void) => {
    if (!conflict) return;
    try {
      if (choice === 'use-server') {
        const envelope: DraftEnvelope<T> = {
          ...conflict.local,
          payload: conflict.server.payload,
          basePayload: conflict.server.payload,
          baseServerUpdatedAt: conflict.server.updated_at,
          updatedAt: new Date().toISOString(),
        };
        writeEnvelope(key, envelope);
        serverBaselineRef.current = conflict.server;
        acceptRestore(restore, conflict.server.payload);
      } else {
        const envelope: DraftEnvelope<T> = {
          ...conflict.local,
          basePayload: conflict.server.payload,
          baseServerUpdatedAt: conflict.server.updated_at,
          updatedAt: new Date().toISOString(),
        };
        writeEnvelope(key, envelope);
        serverBaselineRef.current = conflict.server;
        setConflict(null);
        setCandidate(null);
        restore(conflict.local.payload);
        if (navigator.onLine) await queueServerSync();
        else setState('offline');
      }
      setConflict(null);
    } catch (error) {
      setState('error');
      emit('failed');
      console.error('Could not resolve the draft conflict.', error);
    }
  }, [acceptRestore, conflict, emit, key, queueServerSync]);

  const restoreVersion = useCallback((version: DraftVersion<T>, restore: (value: T) => void) => {
    setCandidate({ source: 'version', payload: version.payload, updatedAt: version.created_at, versionId: version.id });
    setRestorePreviewOpen(true);
    void restore;
  }, []);

  const clearDraft = useCallback(async () => {
    if (!key || !identity.schoolId || !identity.userId) return;
    try {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      await syncQueueRef.current;
      localStorage.removeItem(key);
      const { error } = await requireSupabase().from('quality_of_life_drafts')
        .delete()
        .eq('school_id', identity.schoolId)
        .eq('user_id', identity.userId)
        .eq('entity', identity.entity)
        .eq('entity_id', identity.entityId)
        .eq('form_version', identity.formVersion);
      if (error) throw error;
      setCandidate(null);
      setConflict(null);
      serverBaselineRef.current = null;
    } catch (error) {
      console.error('Could not clear the synced draft copy.', error);
      setState('error');
    }
  }, [identity, key]);

  const keepCurrentForm = useCallback(() => {
    if (!candidate || !key || !identity.userId || !identity.schoolId) return;
    try {
      const currentPayload = payloadRef.current;
      if (encode(currentPayload) !== initialPayloadRef.current) emit('started');
      const local = readEnvelope<T>(key);
      const baseline = serverBaselineRef.current;
      writeEnvelope(key, {
        userId: identity.userId,
        schoolId: identity.schoolId,
        entity: identity.entity,
        entityId: identity.entityId,
        formVersion: identity.formVersion,
        payload: currentPayload,
        updatedAt: new Date().toISOString(),
        baseServerUpdatedAt: local?.baseServerUpdatedAt ?? baseline?.updated_at ?? null,
        basePayload: local?.basePayload ?? baseline?.payload ?? null,
        correlationId: correlationRef.current,
      });
      initialPayloadRef.current = encode(currentPayload);
      lastLocallySavedRef.current = encode(currentPayload);
      setCandidate(null);
      setConflict(null);
      setRestorePreviewOpen(false);
      setState(navigator.onLine ? 'saved_local' : 'offline');
      if (navigator.onLine) void queueServerSync();
    } catch (error) {
      setState('error');
      emit('failed');
      console.error('Could not keep the current form as the active draft.', error);
    }
  }, [candidate, emit, identity, key, queueServerSync]);

  return {
    state,
    candidate,
    conflict,
    versions,
    restorePreviewOpen,
    setRestorePreviewOpen,
    versionHistoryOpen,
    setVersionHistoryOpen,
    loadVersions,
    acceptRestore,
    resolveConflict,
    restoreVersion,
    clearDraft,
    keepCurrentForm,
  };
}
