import {
  canonicalDigest,
  type OutcomeCheckpointClaim,
  type OutcomeHandoffAmendment,
  type OutcomeHandoffCompletion,
  type OutcomeRecord,
  type OutcomeWaitCondition,
} from './controller-schema';

export function stableHandoffWait(wait: OutcomeWaitCondition) {
  const { restartObservedRevision: _, ...stable } = wait;
  return stable;
}

export function sameHandoffWait(
  a: OutcomeWaitCondition,
  b: OutcomeWaitCondition,
) {
  return (
    a.referenceId === b.referenceId &&
    a.createdRevision === b.createdRevision &&
    a.originatingServerEpoch === b.originatingServerEpoch
  );
}

export function effectiveHandoff(
  record: OutcomeRecord,
  wait: OutcomeWaitCondition,
) {
  const history = (record.receipts.handoffAmendments ?? []).filter((entry) =>
    sameHandoffWait(entry.originalWait, wait),
  );
  const latest = history.at(-1);
  return {
    latest,
    head: latest?.payloadDigest ?? 'genesis',
    obligation: latest?.newObligation ?? {
      instructions: wait.instructions ?? null,
      expectedPostRestartCheck: wait.expectedPostRestartCheck ?? null,
      candidateFingerprint: null,
    },
  };
}

export function obligationDigest(
  value: ReturnType<typeof effectiveHandoff>['obligation'],
) {
  return canonicalDigest('omos/external-handoff-obligation/v1', value);
}
export function handoffSourceDigest(value: unknown) {
  return canonicalDigest('omos/external-handoff-source/v1', value);
}
export function handoffEvidenceDigest(value: unknown) {
  return canonicalDigest('omos/external-handoff-evidence/v1', value);
}
export function amendmentDigest(
  value: Omit<OutcomeHandoffAmendment, 'payloadDigest'>,
) {
  const { payloadDigest: _, ...fields } = value as OutcomeHandoffAmendment;
  return canonicalDigest('omos/external-handoff-amendment/v1', fields);
}
export function completionDigest(
  value: Omit<OutcomeHandoffCompletion, 'payloadDigest'>,
) {
  const { payloadDigest: _, ...fields } = value as OutcomeHandoffCompletion;
  return canonicalDigest('omos/external-handoff-completion/v1', fields);
}

export function amendedHandoffBinding(
  record: OutcomeRecord,
): OutcomeCheckpointClaim['amendedHandoff'] {
  const latest = record.receipts.handoffAmendments?.at(-1);
  if (!latest) return undefined;
  const completion = record.receipts.handoffCompletions?.find(
    (entry) => entry.amendmentHead === latest.payloadDigest,
  );
  requireCondition(completion, 'final snapshot requires amended completion');
  return {
    amendmentHead: latest.payloadDigest,
    completionDigest: completion.payloadDigest,
    instructions: latest.request.instructions,
    expectedPostRestartCheck: latest.request.expectedPostRestartCheck,
    candidateFingerprint: latest.request.candidateFingerprint,
  };
}

export function amendmentAuthorizesCompletion(
  amendment: OutcomeHandoffAmendment | undefined,
  epoch: string,
  restartRevision: number,
  userId: string,
  evidenceId: string,
): boolean {
  return (
    amendment?.request.completionAuthorized === true &&
    amendment.serverEpoch === epoch &&
    amendment.request.waitRestartObservedRevision === restartRevision &&
    amendment.request.sourceUserMessageReceiptId === userId &&
    amendment.request.evidenceAttestationId === evidenceId
  );
}

// Bounded public projection, intentionally excluding claim tokens and raw records.
export function projectHandoff(record: OutcomeRecord) {
  const wait = record.waitCondition;
  if (wait?.kind !== 'external_handoff') return undefined;
  const effective = effectiveHandoff(record, wait);
  return {
    rootSessionId: record.rootSessionId,
    outcomeId: record.outcomeId,
    generation: record.generation ?? 1,
    original: stableHandoffWait(wait),
    currentRestartObservedRevision: wait.restartObservedRevision,
    currentServerEpoch: record.serverEpoch,
    effective: effective.obligation,
    amendmentHead: effective.head,
    obligationDigest: obligationDigest(effective.obligation),
    completionAuthorized:
      effective.latest?.request.completionAuthorized === true,
    amendmentAuthority: effective.latest
      ? {
          sourceUserMessageReceiptId:
            effective.latest.request.sourceUserMessageReceiptId,
          evidenceAttestationId: effective.latest.request.evidenceAttestationId,
          amendedRevision: effective.latest.amendedRevision,
          serverEpoch: effective.latest.serverEpoch,
          restartObservedRevision:
            effective.latest.request.waitRestartObservedRevision,
        }
      : undefined,
    userReceipts: record.receipts.userMessages.map((entry) => ({
      id: entry.id,
      messageId: entry.messageId,
      provenance: entry.provenance,
      createdRevision: entry.createdRevision,
      observedEpoch: entry.observedEpoch,
    })),
    evidenceReceipts: record.receipts.evidence.flatMap((entry) =>
      entry.kind === 'orchestrator_attestation'
        ? [
            {
              id: entry.id,
              kind: entry.kind,
              description: entry.description,
              createdRevision: entry.createdRevision,
              assertedStatus: entry.assertedStatus,
              assertedFreshness: entry.assertedFreshness,
              candidateFingerprint: entry.candidateFingerprint,
            },
          ]
        : [],
    ),
  };
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`External handoff amendment: ${message}`);
}

// Shared by locked mutation persistence, reload, and accepted-record validation.
export function validateHandoffAmendments(record: OutcomeRecord): void {
  const binding = record.checkpoint?.amendedHandoff;
  if (binding) {
    const amendment = record.receipts.handoffAmendments?.find(
      (entry) => entry.payloadDigest === binding.amendmentHead,
    );
    const completion = record.receipts.handoffCompletions?.find(
      (entry) =>
        entry.payloadDigest === binding.completionDigest &&
        entry.amendmentHead === binding.amendmentHead,
    );
    requireCondition(
      amendment &&
        completion &&
        record.checkpoint?.kind === 'final' &&
        completion.completedRevision <= record.checkpoint.outcomeRevision &&
        binding.instructions === amendment.request.instructions &&
        binding.expectedPostRestartCheck ===
          amendment.request.expectedPostRestartCheck &&
        binding.candidateFingerprint === amendment.request.candidateFingerprint,
      'checkpoint binding requires retained matching amendment/completion history',
    );
  }
  if (record.finalCertificate) {
    requireCondition(
      handoffSourceDigest(record.finalCertificate.amendedHandoff ?? null) ===
        handoffSourceDigest(binding ?? null),
      'certificate amendment binding mismatch',
    );
  }
  const prefix: OutcomeRecord = {
    ...record,
    receipts: { ...record.receipts, handoffAmendments: [] },
  };
  let previousRevision = 0;
  const replayKeys = new Set<string>();
  for (const entry of record.receipts.handoffAmendments ?? []) {
    const request = entry.request;
    const wait = entry.originalWait;
    const effective = effectiveHandoff(prefix, wait);
    const key = JSON.stringify([
      wait.referenceId,
      wait.createdRevision,
      wait.originatingServerEpoch,
      request.sourceUserMessageReceiptId,
    ]);
    requireCondition(!replayKeys.has(key), 'duplicate source/wait replay');
    replayKeys.add(key);
    requireCondition(
      request.rootSessionId === record.rootSessionId &&
        request.outcomeId === record.outcomeId &&
        request.generation === (record.generation ?? 1),
      'outcome identity mismatch',
    );
    requireCondition(
      wait.kind === 'external_handoff' &&
        wait.restartObservedRevision === undefined &&
        wait.referenceId === request.waitReferenceId &&
        wait.createdRevision === request.waitCreatedRevision &&
        wait.originatingServerEpoch === request.waitOriginatingServerEpoch,
      'original wait identity mismatch',
    );
    requireCondition(
      request.waitRestartObservedRevision > wait.createdRevision &&
        request.waitRestartObservedRevision < entry.amendedRevision &&
        entry.serverEpoch !== wait.originatingServerEpoch,
      'restart fence mismatch',
    );
    requireCondition(
      entry.amendedRevision > previousRevision &&
        entry.amendedRevision <= record.revision &&
        entry.amendedAt <= record.updatedAt,
      'audit ordering mismatch',
    );
    previousRevision = entry.amendedRevision;
    requireCondition(
      effective.head === request.expectedPreviousAmendmentHead &&
        obligationDigest(effective.obligation) ===
          request.oldEffectiveObligationDigest &&
        obligationDigest(entry.oldObligation) ===
          request.oldEffectiveObligationDigest,
      'prior head/obligation mismatch',
    );
    if (effective.latest) {
      requireCondition(
        handoffSourceDigest(effective.latest.originalWait) ===
          handoffSourceDigest(wait),
        'original wait changed',
      );
      requireCondition(
        entry.serverEpoch === effective.latest.serverEpoch
          ? request.waitRestartObservedRevision ===
              effective.latest.request.waitRestartObservedRevision
          : request.waitRestartObservedRevision >
              effective.latest.amendedRevision,
        'prior amendment restart fence mismatch',
      );
    }
    requireCondition(
      obligationDigest(entry.newObligation) ===
        obligationDigest({
          instructions: request.instructions,
          expectedPostRestartCheck: request.expectedPostRestartCheck,
          candidateFingerprint: request.candidateFingerprint,
        }),
      'new obligation mismatch',
    );
    validateEvidence(
      record,
      request.sourceUserMessageReceiptId,
      request.evidenceAttestationId,
      entry.sourceReceiptDigest,
      entry.evidenceDigest,
      entry.serverEpoch,
      Math.max(
        request.waitRestartObservedRevision,
        effective.latest?.amendedRevision ?? 0,
      ),
      entry.amendedRevision,
      entry.newObligation,
    );
    requireCondition(
      amendmentDigest(entry) === entry.payloadDigest,
      'audit digest mismatch',
    );
    prefix.receipts.handoffAmendments!.push(entry);
  }
  if (record.waitCondition) {
    const effective = effectiveHandoff(record, record.waitCondition);
    if (effective.latest) {
      requireCondition(
        handoffSourceDigest(stableHandoffWait(record.waitCondition)) ===
          handoffSourceDigest(effective.latest.originalWait),
        'live original wait changed',
      );
      requireCondition(
        (record.waitCondition.restartObservedRevision ?? 0) >=
          effective.latest.request.waitRestartObservedRevision,
        'live restart fence regressed',
      );
    }
  }
  const completed = new Set<string>();
  for (const completion of record.receipts.handoffCompletions ?? []) {
    const amendment = record.receipts.handoffAmendments?.find(
      (entry) => entry.payloadDigest === completion.amendmentHead,
    );
    requireCondition(
      amendment && !completed.has(completion.amendmentHead),
      'missing/duplicate completion head',
    );
    completed.add(completion.amendmentHead);
    requireCondition(
      effectiveHandoff(record, amendment.originalWait).head ===
        completion.amendmentHead,
      'completion is not latest head',
    );
    requireCondition(
      !record.waitCondition ||
        !sameHandoffWait(record.waitCondition, amendment.originalWait),
      'completed wait still active',
    );
    requireCondition(
      completion.restartObservedRevision >=
        amendment.request.waitRestartObservedRevision &&
        completion.completedRevision > amendment.amendedRevision &&
        completion.completedRevision <= record.revision &&
        completion.completedAt <= record.updatedAt &&
        completion.serverEpoch !==
          amendment.originalWait.originatingServerEpoch,
      'completion fence mismatch',
    );
    requireCondition(
      completion.serverEpoch === amendment.serverEpoch
        ? completion.restartObservedRevision ===
            amendment.request.waitRestartObservedRevision
        : completion.restartObservedRevision > amendment.amendedRevision,
      'completion restart epoch mismatch',
    );
    validateEvidence(
      record,
      completion.sourceUserMessageReceiptId,
      completion.evidenceAttestationId,
      completion.sourceReceiptDigest,
      completion.evidenceDigest,
      completion.serverEpoch,
      amendmentAuthorizesCompletion(
        amendment,
        completion.serverEpoch,
        completion.restartObservedRevision,
        completion.sourceUserMessageReceiptId,
        completion.evidenceAttestationId,
      )
        ? completion.restartObservedRevision
        : Math.max(
            amendment.amendedRevision,
            completion.restartObservedRevision,
          ),
      completion.completedRevision,
      amendment.newObligation,
    );
    requireCondition(
      completionDigest(completion) === completion.payloadDigest,
      'completion digest mismatch',
    );
  }
  for (const entry of record.receipts.handoffAmendments ?? []) {
    if (
      effectiveHandoff(record, entry.originalWait).head !== entry.payloadDigest
    )
      continue;
    requireCondition(
      completed.has(entry.payloadDigest) ||
        (record.waitCondition &&
          sameHandoffWait(record.waitCondition, entry.originalWait)),
      'amended wait disappeared without completion',
    );
  }
}

function validateEvidence(
  record: OutcomeRecord,
  userId: string,
  evidenceId: string,
  sourceDigest: string,
  evidenceDigest: string,
  epoch: string,
  fence: number,
  revision: number,
  obligation: OutcomeHandoffAmendment['newObligation'],
) {
  const user = record.receipts.userMessages.find(
    (entry) => entry.id === userId,
  );
  const evidence = record.receipts.evidence.find(
    (entry) => entry.id === evidenceId,
  );
  requireCondition(
    user?.provenance === 'external_user' &&
      user.observedEpoch === epoch &&
      user.createdRevision > fence &&
      user.createdRevision < revision &&
      handoffSourceDigest(user) === sourceDigest,
    'requires fresh genuine external_user receipt',
  );
  requireCondition(
    evidence?.kind === 'orchestrator_attestation' &&
      evidence.createdRevision > user.createdRevision &&
      evidence.createdRevision < revision &&
      evidence.assertedStatus === 'passed' &&
      evidence.assertedFreshness === 'fresh' &&
      evidence.description === obligation.expectedPostRestartCheck &&
      evidence.candidateFingerprint === obligation.candidateFingerprint &&
      handoffEvidenceDigest(evidence) === evidenceDigest,
    'requires subsequent matching passed fresh attestation',
  );
}

export function assertAmendedFinalReview(record: OutcomeRecord): void {
  const latest = record.receipts.handoffAmendments?.at(-1);
  if (!latest) return;
  const completion = record.receipts.handoffCompletions?.find(
    (entry) => entry.amendmentHead === latest.payloadDigest,
  );
  const claim = record.checkpoint;
  requireCondition(
    handoffSourceDigest(claim?.amendedHandoff ?? null) ===
      handoffSourceDigest(amendedHandoffBinding(record)),
    'new final snapshot must bind latest amendment and completion',
  );
  requireCondition(
    completion &&
      claim?.kind === 'final' &&
      claim.outcomeRevision > latest.amendedRevision &&
      claim.outcomeRevision >= completion.completedRevision &&
      claim.candidateFingerprint ===
        latest.newObligation.candidateFingerprint &&
      claim.includedEvidenceAttestationIds.includes(
        completion.evidenceAttestationId,
      ),
    'new final snapshot must include effective completion evidence and candidate',
  );
}
