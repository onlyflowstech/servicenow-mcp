/**
 * The fixed bounds on sn_batch. They are not profile settings; sn_batch
 * enforces them for every profile, and the policy card reports them from here
 * so the card and the tool cannot drift apart.
 *
 * @module batch-limits
 */

export const BATCH_LIMITS = Object.freeze({
  /** Records a run affects when the caller gives no limit. */
  defaultLimit: 200,
  /** Largest limit a caller may ask for. */
  maxLimit: 10_000,
  /** Requests in one ServiceNow REST Batch API call. */
  restBatchChunkSize: 50,
  /** Records a dry run previews. */
  dryRunSampleSize: 5,
});
