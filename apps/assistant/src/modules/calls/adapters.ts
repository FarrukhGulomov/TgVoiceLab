import type { ApprovedCallPlan, CallAdapterCapabilities, CallHandle, ReconcileResult, TelegramCallAdapter } from '@tgvl/contracts';
import { CapabilityUnavailableError } from '../../application/errors.js';
import type { DerivedCapabilities } from './capability-evidence.js';

/** Fail-closed default: reports every capability false and refuses to dial. */
export class DisabledCallAdapter implements TelegramCallAdapter {
  constructor(
    private readonly fingerprint: string,
    private readonly reasons: string[] = ['calling adapter disabled'],
  ) {}
  async capabilities(): Promise<CallAdapterCapabilities> {
    return { privateOutbound: false, privateInbound: false, pcmSend: false, pcmReceive: false, evidenceArtifact: null, buildFingerprint: this.fingerprint };
  }
  async dial(): Promise<CallHandle> {
    throw new CapabilityUnavailableError(`calling unavailable: ${this.reasons.join('; ')}`);
  }
  async reconcile(): Promise<ReconcileResult> {
    return 'unknown';
  }
}

/**
 * Wraps a real adapter so that capability reports and dialing are governed by the evidence artifact, never by the
 * inner adapter's own claims or any config flag. If evidence does not show production calling is allowed, `dial` refuses.
 */
export class EvidenceGatedCallAdapter implements TelegramCallAdapter {
  constructor(
    private readonly inner: TelegramCallAdapter,
    private readonly derive: () => DerivedCapabilities,
    /** Calls addressed to this numeric id are owner calls (owner-only gate); every other recipient needs the full gate. */
    private readonly ownerTelegramId: string | null = null,
  ) {}
  async capabilities(): Promise<CallAdapterCapabilities> {
    const d = this.derive();
    const { productionCallingAllowed: _p, ownerCallingAllowed: _o, thirdPartyConsentMechanismProven: _t, reasons: _r, ...caps } = d;
    void _p;
    void _o;
    void _t;
    void _r;
    return caps;
  }
  async dial(plan: ApprovedCallPlan, signal: AbortSignal): Promise<CallHandle> {
    const d = this.derive();
    const allowed = plan.recipientTelegramId === this.ownerTelegramId ? d.ownerCallingAllowed : d.productionCallingAllowed;
    if (!allowed || !d.privateOutbound || !d.pcmSend || !d.pcmReceive)
      throw new CapabilityUnavailableError(`calling not verified for this build: ${d.reasons.join('; ') || 'no evidence'}`);
    return this.inner.dial(plan, signal);
  }
  reconcile(providerCallId: string): Promise<ReconcileResult> {
    return this.inner.reconcile(providerCallId);
  }
}
