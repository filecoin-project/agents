import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import {
  NoEndorsedProviderError,
  TransactionNotAppliedError,
} from '@filoz/synapse-core/errors'
import * as Piece from '@filoz/synapse-core/piece'
import * as SP from '@filoz/synapse-core/sp'
import * as WarmStorage from '@filoz/synapse-core/warm-storage'
import { CliError } from 'clipact'
import type { App } from '../app.ts'
import { buildFundingUrl, targetBalance } from '../auth/login.ts'
import type { SessionKey } from '../auth/session.ts'
import { ErrorCodes, notFound } from '../errors.ts'
import type { StorageBackend } from './types.ts'

/**
 * Create the synapse-core storage backend: one copy on one Curio provider,
 * signed by the session key and paid for by its root wallet. Chain reads are
 * cancelled by `app.transport`, and provider calls and receipt waits take
 * `app.signal`.
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

  return {
    async selectPlacement({ metadata, providerId }) {
      let location: WarmStorage.ResolvedLocation | undefined
      if (providerId == null) {
        try {
          // Only endorsed providers, the best one that answers its ping.
          ;[location] = await WarmStorage.selectReachableProviders(client, {
            address: payer,
            metadata,
            requireEndorsedPrimary: true,
            signal,
          })
        } catch (error) {
          if (!NoEndorsedProviderError.is(error)) throw error
        }
        if (!location) {
          throw new CliError({
            code: 'service_unavailable',
            message: 'No reachable storage provider is available.',
          })
        }
      } else {
        // A named provider is used as is: no ping, and endorsed or not.
        const input = await WarmStorage.fetchProviderSelectionInput(client, {
          address: payer,
        })
        ;[location] = WarmStorage.selectProviders({
          ...input,
          metadata,
          providerId,
        })
        if (!location) {
          throw notFound(
            `Provider ${providerId} is not an approved Warm Storage provider.`
          )
        }
      }
      const { provider, dataSetId, clientDataSetId } = location
      return {
        providerId: provider.id,
        serviceURL: provider.pdp.serviceURL,
        payee: provider.payee,
        ...(dataSetId == null || clientDataSetId == null
          ? {}
          : { dataSetId, clientDataSetId }),
      }
    },

    async quote({ size, placement }) {
      const costs = await WarmStorage.getUploadCosts(client, {
        clientAddress: payer,
        pieceSizes: [BigInt(size)],
        ...(placement.dataSetId == null
          ? { isNewDataSet: true }
          : { dataSetId: placement.dataSetId }),
      })
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
          balance: targetBalance({
            ...costs.account,
            depositNeeded: costs.depositNeeded,
          }),
        }),
      }
    },

    async hasPiece({ serviceURL, pieceCid }) {
      return await SP.hasPiece({
        serviceURL,
        pieceCid: Piece.from(pieceCid),
        signal,
      })
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
      const dataSet = await WarmStorage.getDataSet(client, { dataSetId })
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

    async waitForRemoval({ transactionHash, dataSetId, pieceId }) {
      try {
        await SP.waitForDeletePieces({
          client,
          txHash: transactionHash,
          dataSetId,
          pieceIds: [pieceId],
          signal,
        })
        return { scheduled: true }
      } catch (error) {
        if (TransactionNotAppliedError.is(error)) return { scheduled: false }
        throw error
      }
    },
  }
}

/** First piece ID of a confirmed commit. */
function firstId(ids: readonly bigint[]): bigint {
  const [id] = ids
  if (id == null) throw new Error('The commit added no piece IDs.')
  return id
}
