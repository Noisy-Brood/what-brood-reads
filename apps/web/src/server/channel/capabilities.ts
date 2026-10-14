/**
 * What a provider can do, declared by its adapter and never discovered at
 * runtime (DD16 §4, D14 §4). A product that finds a verb missing in front of
 * the person has already failed them; one that reads a declaration offers only
 * the verbs the channel can honour, and says why the others are absent.
 */
export interface Capabilities {
  /** A native rule engine at all. */
  installsRules: boolean;
  /**
   * Its rules run before the person sees the item. What suppression turns on
   * (D14 §2): without it, quieting moves mail after it arrived, and says the
   * interruption is not prevented.
   */
  rulesActBeforeDelivery: boolean;
  /** A rule can be changed in place, or only replaced by a new one. */
  rulesEditable: boolean;
  /** Items can be taken out of view, and put back. */
  canMove: boolean;
  /** A classification can be applied to items already received. */
  canClassifyRetroactively: boolean;
  /** An item can carry many classifications, or only one home. */
  supportsMultipleClassifications: boolean;
  /** A cheap delta of changes, or only a full re-enumeration. */
  incrementalSync: boolean;
}
