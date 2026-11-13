import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { TransactionNotAppliedError } from '@filoz/synapse-core/errors'
import * as Pay from '@filoz/synapse-core/pay'
import * as PDPVerifier from '@filoz/synapse-core/pdp-verifier'
import * as Piece from '@filoz/synapse-core/piece'
import * as SP from '@filoz/synapse-core/sp'
import * as SPRegistry from '@filoz/synapse-core/sp-registry'
import * as WarmStorage from '@filoz/synapse-core/warm-storage'
import { CliError } from 'clipact'
import { waitForTransactionReceipt } from 'viem/actions'
import type { App } from '../app.ts'
import { buildFundingUrl, targetBalance } from '../auth/login.ts'
import type { SessionKey } from '../auth/session.ts'
import { abortable, ErrorCodes, notFound } from '../errors.ts'
import type { Placement, StorageBackend } from './types.ts'

/**
 * Create the synapse-core storage backend: one copy on one Curio provider,
 * signed by the session key and paid for by its root wallet. Chain reads are
 * cancelled by `app.transport`, provider calls take `app.signal`, and the
 * viem receipt wait is wrapped with {@link abortable}.
 *
 * @see https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-core
 */
export function createSynapseBackend(
  app: App,
  sessionKey: SessionKey
): StorageBackend {
  const client = app.client
  const signer = sessionKey.client
  const payer = sessionKey.rootAddress
  const signal = app.signal
  const dataSets = new Map<
    bigint,
    ReturnType<typeof WarmStorage.getPdpDataSet>
  >()

  /**
   * Read a data set once per invocation; placement and quote share it. A
   * failed read is forgotten so the next call tries again.
   */
  function getDataSet(dataSetId: bigint) {
    let dataSet = dataSets.get(dataSetId)
    if (!dataSet) {
      dataSet = WarmStorage.getPdpDataSet(client, { dataSetId })
      dataSet.catch(() => dataSets.delete(dataSetId))
      dataSets.set(dataSetId, dataSet)
    }
    return dataSet
  }

  /** Whether a provider answers its PDP ping. */
  async function isReachable(serviceURL: string): Promise<boolean> {
    try {
      await SP.ping(serviceURL, { signal })
      return true
    } catch (error) {
      if (signal?.aborted) throw error
      return false
    }
  }

  return {
    async selectPlacement({ metadata, providerId }) {
      const [input, provider] = await Promise.all([
        WarmStorage.fetchProviderSelectionInput(client, { address: payer }),
        providerId == null
          ? undefined
          : SPRegistry.getPDPProvider(client, { providerId }),
      ])
      if (providerId != null) {
        if (!provider) {
          throw notFound(`Provider ${providerId} has no active PDP offering.`)
        }
        const matches = WarmStorage.findMatchingDataSets(
          input.clientDataSets.filter((ds) => ds.providerId === providerId),
          metadata,
          input.legacyPieceStorageIdLimit
        )
        return withDataSet({
          providerId,
          serviceURL: provider.pdp.serviceURL,
          payee: provider.payee,
          dataSetId: matches[0]?.dataSetId,
        })
      }
      const excluded: bigint[] = []
      for (;;) {
        const [location] = WarmStorage.selectProviders({
          ...input,
          count: 1,
          metadata,
          excludeProviderIds: excluded,
        })
        if (!location) {
          throw new CliError({
            code: 'service_unavailable',
            message: 'No reachable storage provider is available.',
          })
        }
        const candidate = location.provider
        if (await isReachable(candidate.pdp.serviceURL)) {
          return withDataSet({
            providerId: candidate.id,
            serviceURL: candidate.pdp.serviceURL,
            payee: candidate.payee,
            dataSetId: location.dataSetId ?? undefined,
          })
        }
        excluded.push(candidate.id)
      }
    },

    async quote({ size, placement }) {
      const existing =
        placement.dataSetId == null
          ? undefined
          : await existingDataSetCosts(placement.dataSetId)
      const costs = await WarmStorage.getUploadCosts(client, {
        clientAddress: payer,
        pieceSizes: [BigInt(size)],
        isNewDataSet: existing == null,
        ...existing,
      })
      // The balance target needs the account's funds, read only for a deposit.
      const summary =
        costs.depositNeeded > 0n
          ? await Pay.getAccountSummary(client, { address: payer })
          : undefined
      return {
        ready: costs.ready,
        depositNeeded: costs.depositNeeded,
        needsApproval: costs.needsFwssMaxApproval,
        ratePerMonth: costs.rates.perMonth,
        lockup: costs.lockups.total,
        fundingUrl: buildFundingUrl({
          consoleUrl: app.consoleUrl,
          network: app.network,
          tags: app.linkTags,
          deposit: costs.depositNeeded,
          ...(summary
            ? {
                balance: targetBalance({
                  ...summary,
                  depositNeeded: costs.depositNeeded,
                }),
              }
            : {}),
        }),
      }
    },

    async hasPiece({ serviceURL, pieceCid }) {
      try {
        await SP.findPiece({
          serviceURL,
          pieceCid: Piece.from(pieceCid),
          signal,
        })
        return true
      } catch (error) {
        if (signal?.aborted) throw error
        return false
      }
    },

    async upload({ serviceURL, path, size, pieceCid }) {
      const cid = Piece.from(pieceCid)
      await SP.uploadPieceStreaming({
        serviceURL,
        data: Readable.toWeb(createReadStream(path)) as ReadableStream,
        size,
        pieceCid: cid,
        signal,
      })
      await SP.findPiece({ serviceURL, pieceCid: cid, poll: true, signal })
    },

    async signCommit({ placement, pieceCid, metadata, pieceMetadata }) {
      const pieces = [
        { pieceCid: Piece.from(pieceCid), metadata: pieceMetadata },
      ]
      if (placement.dataSetId == null) {
        return await SP.prepareCreateDataSetAndAddPieces(signer, {
          // FWSS verifies the signature against the registry payee.
          payee: placement.payee,
          // Without this the session key address would be the payer.
          payer,
          metadata,
          pieces,
        })
      }
      if (placement.clientDataSetId == null) {
        throw new Error('Adding to a data set requires its client data set ID.')
      }
      return await SP.prepareAddPieces(signer, {
        dataSetId: placement.dataSetId,
        clientDataSetId: placement.clientDataSetId,
        payer,
        pieces,
      })
    },

    async submitCommit({ serviceURL, commit }) {
      // synapse-core never sends a paid mutation once the signal has aborted.
      const result = await SP.submitCommit(client, {
        serviceURL,
        commit,
        signal,
      })
      return { transactionHash: result.txHash }
    },

    async findCommit({ commit }) {
      // FWSS records each used add-pieces nonce, including the add half of
      // create-and-add.
      const { extraData } = commit
      const pieceCount = commit.pieces.length
      const result =
        commit.kind === 'addPieces'
          ? await WarmStorage.getAddPiecesResult(client, {
              payer: commit.payer,
              extraData,
              pieceCount,
            })
          : await WarmStorage.getCreateDataSetAndAddPiecesResult(client, {
              extraData,
              pieceCount,
            })
      if (!('dataSetId' in result)) return undefined
      return { dataSetId: result.dataSetId, pieceId: firstId(result.pieceIds) }
    },

    async waitForCommit({ commit, transactionHash }) {
      const options = {
        client,
        txHash: transactionHash,
        extraData: commit.extraData,
        pieceCount: commit.pieces.length,
        signal,
      }
      try {
        const result =
          commit.kind === 'addPieces'
            ? await SP.waitForAddPieces({ ...options, payer: commit.payer })
            : await SP.waitForCreateDataSetAddPieces(options)
        return {
          dataSetId: result.dataSetId,
          pieceId: firstId(result.pieceIds),
        }
      } catch (error) {
        if (TransactionNotAppliedError.is(error)) {
          throw new CliError({
            code: ErrorCodes.commitRejected,
            message: `Commit transaction ${transactionHash} did not add the piece.`,
            cause: error,
          })
        }
        throw error
      }
    },

    async schedulePieceRemoval({ serviceURL, dataSetId, pieceId }) {
      const dataSet = await getDataSet(dataSetId)
      if (!dataSet) throw notFound(`Data set ${dataSetId} not found.`)
      const result = await SP.schedulePieceDeletions(signer, {
        serviceURL,
        dataSetId,
        clientDataSetId: dataSet.clientDataSetId,
        pieceIds: [pieceId],
        signal,
      })
      return { transactionHash: result.txHash }
    },

    async waitForTransaction(transactionHash) {
      // viem's receipt wait takes no signal.
      const receipt = await abortable(
        waitForTransactionReceipt(client, { hash: transactionHash }),
        signal
      )
      return { status: receipt.status }
    },
  }

  /** Attach the client data set ID when reusing a data set. */
  async function withDataSet(placement: Placement): Promise<Placement> {
    if (placement.dataSetId == null) return placement
    const dataSet = await getDataSet(placement.dataSetId)
    if (!dataSet) return { ...placement, dataSetId: undefined }
    return { ...placement, clientDataSetId: dataSet.clientDataSetId }
  }

  /** Inputs `getUploadCosts` needs for an existing data set. */
  async function existingDataSetCosts(dataSetId: bigint) {
    const [dataSet, leafCount] = await Promise.all([
      getDataSet(dataSetId),
      PDPVerifier.getDataSetLeafCount(client, { dataSetId }),
    ])
    if (!dataSet) return undefined
    return {
      dataSetLeafCount: leafCount,
      currentLifecycleReserveBalance: dataSet.lifecycleReserveBalance,
      pendingOneTimePayments: dataSet.pendingOneTimePayments,
      pdpEndEpoch: dataSet.pdpEndEpoch,
    }
  }
}

/** First piece ID of a confirmed commit. */
function firstId(ids: readonly bigint[]): bigint {
  const [id] = ids
  if (id == null) throw new Error('The commit added no piece IDs.')
  return id
}
