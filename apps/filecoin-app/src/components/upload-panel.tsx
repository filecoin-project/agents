import { AddPiecesPermission } from '@filoz/synapse-core/session-key'
import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import type { PdpDataSet } from '@filoz/synapse-core/warm-storage'
import {
  type UseUploadPiecesResult,
  useUploadPieces,
} from '@filoz/synapse-react'
import { useQueryClient } from '@tanstack/react-query'
import { FileIcon, UploadIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useDashboard } from '@/components/dashboard-context'
import { SignerBadge } from '@/components/signer-badge'
import { TokenAmount } from '@/components/token-amount'
import { txToasts } from '@/components/tx-toast'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { invalidateStorageQueries, useUploadCosts } from '@/hooks-synapse'
import { formatBytes, shortId } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Stage of one file in the progress list. */
type UploadStage = 'queued' | 'uploading' | 'adding' | 'done' | 'error'

/** Progress of one file in the progress list. */
interface FileProgress {
  /** File name. */
  name: string
  /** File size in bytes. */
  size: number
  /** Current stage. */
  stage: UploadStage
  /** Bytes sent to the provider. */
  bytesUploaded: number
  /** PieceCID once the piece is added. */
  pieceCid?: string
  /** Error message when `stage` is `error`. */
  error?: string
}

const STAGE_LABEL: Record<UploadStage, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  adding: 'Adding to data set',
  done: 'Done',
  error: 'Failed',
}

/**
 * Piece metadata stored with each uploaded file.
 *
 * @param file - The file being uploaded.
 */
function fileMetadata(file: File) {
  return { name: file.name, ...(file.type ? { type: file.type } : {}) }
}

/**
 * Drop zone and progress list for uploading files to a data set.
 *
 * @param props.dataSet - Target data set.
 * @param props.onDone - Called with the result after pieces are added.
 */
export function UploadPanel(props: {
  dataSet: PdpDataSet
  onDone?: (result: UseUploadPiecesResult) => void
}) {
  const { address, network, signerFor } = useDashboard()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<{ id: string; file: File }[]>([])
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<FileProgress[]>([])
  // Last whole percent rendered per file, so progress re-renders once per
  // percent rather than once per chunk.
  const percents = useRef<number[]>([])
  const queryClient = useQueryClient()
  const toasts = txToasts(network, 'Upload')
  const patch = (index: number, change: Partial<FileProgress>) =>
    setProgress((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...change } : item))
    )
  const upload = useUploadPieces({
    sessionKey: signerFor([AddPiecesPermission]),
    onHash: toasts.onHash,
    onFileProgress: ({ index, file, bytesUploaded }) => {
      const percent = Math.floor((bytesUploaded / Math.max(file.size, 1)) * 100)
      if (percents.current[index] !== percent) {
        percents.current[index] = percent
        patch(index, {
          stage: bytesUploaded >= file.size ? 'adding' : 'uploading',
          bytesUploaded,
        })
      }
    },
  })
  const resetProgress = () => {
    percents.current = []
    setProgress([])
  }
  const pieceSizes = files.map(({ file }) => BigInt(file.size))
  const costs = useUploadCosts({
    clientAddress: address,
    pieceSizes,
    withCDN: props.dataSet.cdn,
    isNewDataSet: false,
  })
  const tooBig = files.some(
    ({ file }) =>
      props.dataSet.provider &&
      BigInt(file.size) > props.dataSet.provider.pdp.maxPieceSizeInBytes
  )
  // synapse-core rejects these inside the upload stream, where the browser
  // only reports a generic network error, so catch them up front.
  const tooSmall = files.some(
    ({ file }) => file.size < SIZE_CONSTANTS.MIN_UPLOAD_SIZE
  )
  const busy = upload.isPending

  const addFiles = (list: FileList | null) => {
    if (list) {
      setFiles((prev) => [
        ...prev,
        ...Array.from(list, (file) => ({ id: crypto.randomUUID(), file })),
      ])
      resetProgress()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40',
          dragging && 'border-primary bg-accent'
        )}
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
        type="button"
      >
        <UploadIcon className="size-6" />
        <span>Drop files here or click to choose</span>
        <span className="text-xs">Each file becomes one piece.</span>
      </button>
      <input
        className="hidden"
        multiple
        onChange={(event) => {
          addFiles(event.target.files)
          event.target.value = ''
        }}
        ref={input}
        type="file"
      />

      {progress.length > 0 ? (
        <ul className="flex flex-col divide-y overflow-hidden rounded-3xl border">
          {progress.map((file, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: files keep their order
            <li className="flex flex-col gap-2 px-4 py-3" key={index}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileIcon className="size-4 shrink-0" />
                  <span className="truncate">{file.name}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    file.stage === 'error'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  )}
                >
                  {STAGE_LABEL[file.stage]}
                </span>
              </div>
              <Progress
                value={
                  file.stage === 'done'
                    ? 100
                    : Math.round(
                        (file.bytesUploaded / Math.max(file.size, 1)) * 100
                      )
                }
              />
              <span className="truncate font-mono text-xs text-muted-foreground">
                {file.error ??
                  (file.pieceCid
                    ? shortId(file.pieceCid, 12)
                    : formatBytes(file.size))}
              </span>
            </li>
          ))}
        </ul>
      ) : files.length > 0 ? (
        <ul className="flex flex-col divide-y overflow-hidden rounded-3xl border">
          {files.map(({ id, file }) => (
            <li
              className="flex items-center justify-between gap-2 px-4 py-3 text-sm"
              key={id}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileIcon className="size-4 shrink-0" />
                <span className="truncate">{file.name}</span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(file.size)}
                </span>
              </span>
              <Button
                aria-label={`Remove ${file.name}`}
                onClick={() =>
                  setFiles((prev) => prev.filter((item) => item.id !== id))
                }
                size="icon-xs"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {tooBig ? (
        <Alert variant="destructive">
          <AlertTitle>File too large</AlertTitle>
          <AlertDescription>
            This provider accepts pieces up to{' '}
            {formatBytes(props.dataSet.provider?.pdp.maxPieceSizeInBytes)}.
          </AlertDescription>
        </Alert>
      ) : null}
      {tooSmall ? (
        <Alert variant="destructive">
          <AlertTitle>File too small</AlertTitle>
          <AlertDescription>
            Pieces must be at least {SIZE_CONSTANTS.MIN_UPLOAD_SIZE} bytes.
            Remove the smaller files to upload the rest.
          </AlertDescription>
        </Alert>
      ) : null}

      {costs.data && files.length > 0 && progress.length === 0 ? (
        costs.data.ready ? (
          <p className="text-xs text-muted-foreground">
            Adds about{' '}
            <TokenAmount
              network={network}
              suffix="/month"
              value={costs.data.rates.perMonth}
            />{' '}
            plus <TokenAmount network={network} value={costs.data.fees.total} />{' '}
            in fees.
          </p>
        ) : (
          <Alert>
            <AlertTitle>Funding needed</AlertTitle>
            <AlertDescription>
              {costs.data.depositNeeded > 0n ? (
                <>
                  Deposit at least{' '}
                  <TokenAmount
                    network={network}
                    value={costs.data.depositNeeded}
                  />{' '}
                  into your Pay account.{' '}
                </>
              ) : null}
              {costs.data.needsFwssMaxApproval
                ? 'Approve Warm Storage before uploading.'
                : null}
            </AlertDescription>
          </Alert>
        )
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SignerBadge permissions={[AddPiecesPermission]} />
        <div className="flex gap-2">
          {progress.length > 0 && !busy ? (
            <Button
              onClick={() => {
                setFiles([])
                resetProgress()
              }}
              variant="outline"
            >
              Clear
            </Button>
          ) : null}
          <Button
            disabled={
              files.length === 0 ||
              busy ||
              tooBig ||
              tooSmall ||
              !props.dataSet.provider
            }
            onClick={() => {
              const inputs = files.map(({ file }) => file)
              percents.current = []
              setProgress(
                inputs.map((file) => ({
                  name: file.name,
                  size: file.size,
                  stage: 'queued',
                  bytesUploaded: 0,
                }))
              )
              upload.mutate(
                {
                  dataSet: props.dataSet,
                  files: inputs,
                  metadata: fileMetadata,
                },
                {
                  onSuccess: (result) => {
                    setProgress((prev) =>
                      prev.map((item, i) => {
                        const piece = result.pieces.find(
                          (p) => p.file === inputs[i]
                        )
                        if (piece) {
                          return {
                            ...item,
                            stage: 'done',
                            bytesUploaded: item.size,
                            pieceCid: piece.pieceCid.toString(),
                          }
                        }
                        const failed = result.failed.find(
                          (f) => f.file === inputs[i]
                        )
                        return failed
                          ? {
                              ...item,
                              stage: 'error',
                              error: failed.error.message,
                            }
                          : item
                      })
                    )
                    // More data raises the rail rate, lockup and FWSS allowance usage.
                    void invalidateStorageQueries(queryClient)
                    const count = result.pieces.length
                    const added = `Added ${count} piece${count === 1 ? '' : 's'}`
                    const failed = result.failed.length
                    if (failed > 0) {
                      toasts.warning(
                        added,
                        `${failed} file${failed === 1 ? '' : 's'} failed; upload again to retry.`
                      )
                    } else {
                      toasts.success(added)
                    }
                    // Keep only the failed files selected so they can be retried.
                    const retry = new Set(result.failed.map(({ file }) => file))
                    setFiles((prev) =>
                      prev.filter(({ file }) => retry.has(file))
                    )
                    props.onDone?.(result)
                  },
                  onError: (error) => {
                    setProgress((prev) =>
                      prev.map((item) =>
                        item.stage === 'done'
                          ? item
                          : { ...item, stage: 'error', error: error.message }
                      )
                    )
                    toasts.mutation.onError(error)
                  },
                }
              )
            }}
          >
            {busy ? <Spinner /> : <UploadIcon />}
            Upload{' '}
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? '' : 's'}`
              : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}
