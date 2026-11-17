import { createReadStream } from 'node:fs'
import {
  DataSetNotFoundError,
  NoEndorsedProviderError,
  PDPProviderUnavailableError,
  ServiceAlreadyTerminatedError,
  TransactionNotAppliedError,
} from '@filoz/synapse-core/errors'
import * as Pay from '@filoz/synapse-core/pay'
import {
  getDataSetLeafCounts,
  getScheduledRemovals,
} from '@filoz/synapse-core/pdp-verifier'
import * as Piece from '@filoz/synapse-core/piece'
import * as SP from '@filoz/synapse-core/sp'
import { calculateUploadCosts } from '@filoz/synapse-core/utils'
import * as WarmStorage from '@filoz/synapse-core/warm-storage'
import { CliError } from 'clipact'
import type { Address, Chain, Client, Transport } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'
import type { App } from '../app.ts'
import { buildFundingUrl, targetBalance } from '../auth/login.ts'
import type { SessionKey } from '../auth/session.ts'
import { ErrorCodes, notFound } from '../errors.ts'
import { createSecondaryCopyBackend } from './secondary-copy.ts'
import type { Placement, StorageBackend } from './types.ts'

/**
 * Create the synapse-core storage backend for copies on Curio providers,
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
    // secondary-copy: remove this line to go back to one copy.
    ...createSecondaryCopyBackend(app, sessionKey),

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
        // A named provider is used as is: no ping, and endorsed or not. Only
        // that provider is read, so its Warm Storage approval is read apart.
        const [approved, locations] = await Promise.all([
          readContract(client, {
            ...app.chain.contracts.fwssView,
            functionName: 'isProviderApproved',
            args: [providerId],
          }),
          WarmStorage.resolveProviderLocations(client, {
            address: payer,
            providerIds: [providerId],
            metadata,
          }).catch((error: unknown) => {
            if (PDPProviderUnavailableError.is(error)) return []
            throw error
          }),
        ])
        location = approved ? locations[0] : undefined
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

    async quote({ size, placements }) {
      const costs = await uploadCosts(client, {
        payer,
        size: BigInt(size),
        placements,
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
      await SP.uploadPieceStreaming({
        serviceURL,
        data: createReadStream(path, { signal }),
        size,
        pieceCid: Piece.from(pieceCid),
        signal,
        waitForParked: true,
      })
    },

    async uploadStream({ serviceURL, data, size }) {
      // Without `pieceCid`, synapse-core hashes the body as it sends it.
      const result = await SP.uploadPieceStreaming({
        serviceURL,
        data,
        size,
        signal,
        waitForParked: true,
      })
      return { pieceCid: result.pieceCid.toString() }
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

    async pieceState({ dataSetId, pieceId }) {
      const dataSet = await WarmStorage.getDataSet(client, { dataSetId })
      if (!dataSet) return { state: 'removed' }
      const [live, scheduled] = await Promise.all([
        readContract(client, {
          ...app.chain.contracts.pdp,
          functionName: 'pieceLive',
          args: [dataSetId, pieceId],
        }),
        getScheduledRemovals(client, { dataSetId }),
      ])
      return {
        payer: dataSet.payer,
        state: live
          ? scheduled.includes(pieceId)
            ? 'scheduled'
            : 'live'
          : 'removed',
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

/**
 * Costs of one piece of `size` bytes in each placement's data set, priced
 * together against the payer's account. synapse-core's `getUploadCosts`
 * prices one data set; this follows synapse-sdk's
 * `calculateMultiContextCosts`, which prices several at once so their
 * deposits are not counted against the same funds twice.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-sdk/src/storage/manager.ts
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/warm-storage/get-upload-costs.ts
 */
async function uploadCosts(
  client: Client<Transport, Chain>,
  options: { payer: Address; size: bigint; placements: readonly Placement[] }
) {
  const { payer, size, placements } = options
  const dataSetIds = placements.flatMap((placement) =>
    placement.dataSetId == null ? [] : [placement.dataSetId]
  )
  const [account, priceList, currentEpoch, leafCounts, dataSets] =
    await Promise.all([
      Pay.accounts(client, { address: payer }),
      WarmStorage.getPriceList(client),
      getBlockNumber(client, { cacheTime: 0 }),
      getDataSetLeafCounts(client, { dataSetIds }),
      WarmStorage.getDataSetsById(client, { dataSetIds }),
    ])
  const approved = await Pay.isFwssMaxApproved(client, {
    clientAddress: payer,
    requiredMaxLockupPeriod: priceList.lockups.defaultLockupPeriod,
  })
  const accountParams = {
    funds: account.funds,
    lockupCurrent: account.lockupCurrent,
    lockupRate: account.lockupRate,
    lockupLastSettledAt: account.lockupLastSettledAt,
    currentEpoch,
  }
  const debt = Pay.calculateAccountDebt(accountParams)
  const { availableFunds, runwayInEpochs } =
    Pay.resolveAccountState(accountParams)
  const contexts = placements.map((placement) => {
    const { dataSetId } = placement
    if (dataSetId == null) {
      return { pieceSizes: [size], withCDN: false, dataSet: null }
    }
    const dataSet = dataSets.get(dataSetId)
    if (!dataSet) throw new DataSetNotFoundError(dataSetId)
    if (dataSet.pdpEndEpoch !== 0n) {
      throw new ServiceAlreadyTerminatedError(dataSet.pdpEndEpoch)
    }
    return {
      pieceSizes: [size],
      withCDN: false,
      dataSet: {
        leafCount: leafCounts.get(dataSetId) ?? 0n,
        lifecycleReserveBalance: dataSet.lifecycleReserveBalance,
        pendingOneTimePayments: dataSet.pendingOneTimePayments,
        pdpEndEpoch: dataSet.pdpEndEpoch,
      },
    }
  })
  const costs = calculateUploadCosts({
    contexts,
    priceList,
    account: {
      currentLockupRate: account.lockupRate,
      debt,
      availableFunds,
      runwayInEpochs,
      fwssMaxApproved: approved,
    },
  })
  return { ...costs, account: { availableFunds, debt, runwayInEpochs } }
}

/** First piece ID of a confirmed commit. */
function firstId(ids: readonly bigint[]): bigint {
  const [id] = ids
  if (id == null) throw new Error('The commit added no piece IDs.')
  return id
}
