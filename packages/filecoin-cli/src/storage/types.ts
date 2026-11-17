import type { Commit } from '@filoz/synapse-core/sp'
import type { MetadataObject } from '@filoz/synapse-core/utils'
import type { Address, Hex } from 'viem'
import type { SecondaryCopyBackend } from './secondary-copy.ts'

/** Provider and data set chosen for one copy of an upload. */
export type Placement = {
  providerId: bigint
  serviceURL: string
  payee: Address
  /** Existing data set to add to; `undefined` when a new one is created. */
  dataSetId?: bigint
  clientDataSetId?: bigint
}

/**
 * A commit the provider accepted, awaiting confirmation on chain. The signed
 * `extraData` and the piece count stay in the saved {@link Commit}, which
 * recovers the piece IDs if the receipt wait times out.
 */
export type Submission = { transactionHash: Hex }

/** A confirmed piece in a data set. */
export type CommittedPiece = { dataSetId: bigint; pieceId: bigint }

/** What storing `size` bytes at every placement costs the payer now. */
export type UploadQuote = {
  /** The payer can upload without depositing or approving anything. */
  ready: boolean
  /** USDFC base units to deposit first. */
  depositNeeded: bigint
  /** The payer must approve Warm Storage as an operator first. */
  needsApproval: boolean
  /** Storage rate added by this upload, in USDFC base units per month. */
  ratePerMonth: bigint
  /** Funds locked by this upload, in USDFC base units. */
  lockup: bigint
  /** Console link that prefills the Warm Storage approval and any deposit. */
  fundingUrl: string
}

/**
 * Storage operations used by put and delete jobs. The synapse-core
 * implementation lives in `synapse.ts`; tests substitute a fake so
 * orchestration and resume logic run without a provider or chain. A backend
 * is built for one invocation and cancels its own calls when that
 * invocation's signal aborts.
 */
// secondary-copy: drop `extends SecondaryCopyBackend` to go back to one copy.
export interface StorageBackend extends SecondaryCopyBackend {
  /** Choose one provider, preferring an existing data set with `metadata`. */
  selectPlacement(options: {
    metadata: MetadataObject
    providerId?: bigint | undefined
  }): Promise<Placement>
  /**
   * Price an upload of `size` bytes to each placement together and check
   * the payer's readiness for all of them.
   */
  quote(options: {
    size: number
    placements: readonly Placement[]
  }): Promise<UploadQuote>
  /** Whether the provider already holds the piece. */
  hasPiece(options: { serviceURL: string; pieceCid: string }): Promise<boolean>
  /** Upload bytes and wait until the provider has parked the piece. */
  upload(options: {
    serviceURL: string
    path: string
    size: number
    pieceCid: string
  }): Promise<void>
  /**
   * Upload a stream of `size` bytes, compute its PieceCID on the way, and
   * wait until the provider has parked the piece. Used for CARs, whose
   * PieceCID is unknown until their bytes are written.
   */
  uploadStream(options: {
    serviceURL: string
    data: AsyncIterable<Uint8Array>
    size: number
  }): Promise<{ pieceCid: string }>
  /**
   * Sign a commit without sending it: create-and-add when the placement has
   * no data set, add otherwise. The nonce and client data set ID are chosen
   * here. The commit is JSON-safe and saved before it is sent.
   */
  signCommit(options: {
    placement: Placement
    pieceCid: string
    metadata: MetadataObject
    pieceMetadata: MetadataObject
  }): Promise<Commit>
  /** Send a signed commit to the provider. */
  submitCommit(options: {
    serviceURL: string
    commit: Commit
  }): Promise<Submission>
  /**
   * Find a commit on chain by the nonce in its signed `extraData`. Returns
   * the piece when FWSS has recorded the nonce, or `undefined` when the
   * commit has not landed.
   */
  findCommit(options: { commit: Commit }): Promise<CommittedPiece | undefined>
  /**
   * Wait on chain for a submitted commit. Throws `commit_rejected` when the
   * transaction reverted or did not add the piece.
   */
  waitForCommit(options: {
    commit: Commit
    transactionHash: Hex
  }): Promise<CommittedPiece>
  /** Sign and submit a piece removal. */
  schedulePieceRemoval(options: {
    serviceURL: string
    dataSetId: bigint
    pieceId: bigint
  }): Promise<{ transactionHash: Hex }>
  /**
   * Wait on chain for a removal and report whether its transaction
   * scheduled the piece for removal.
   */
  waitForRemoval(options: {
    transactionHash: Hex
    dataSetId: bigint
    pieceId: bigint
  }): Promise<{ scheduled: boolean }>
}
