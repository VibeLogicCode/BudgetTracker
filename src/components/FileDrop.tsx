'use client';

import { useId, useRef, useState } from 'react';

/**
 * The extensions an `accept` attribute names, MIME types dropped. `accept` is written for the
 * file picker's own filter and mixes the two ('.csv,.ofx,.qfx,text/csv'); a drop has no picker to
 * filter it, so the same list has to be applied here by hand.
 */
export function extensionsFromAccept(accept: string): string[] {
  return accept
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.startsWith('.'));
}

/** English for a list, so a refusal reads as a sentence rather than as a comma-separated dump. */
function orList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

/**
 * Why a drop was refused, or null when it is fine.
 *
 * The extension check is for a fast, specific message only -- it never decides how a file is
 * read. An OFX file saved as .csv still imports, because flow.ts and buildPreview both dispatch
 * on the file's CONTENT (looksLikeOfx checks the bytes as well as the name). Tightening this
 * into a gate would break that.
 */
export function rejectionFor(files: readonly File[], extensions: string[]): string | null {
  if (files.length === 0) return 'That drop carried no file.';
  if (files.length > 1) return 'One file at a time, please — drop a single statement.';
  if (extensions.length === 0) return null;
  const name = files[0]!.name.toLowerCase();
  if (extensions.some((extension) => name.endsWith(extension))) return null;
  return `That looks like ${files[0]!.name}. Drop a ${orList(extensions)} file instead.`;
}

/**
 * Hands the browser's own input the dropped file, so the surrounding <form> submits it exactly as
 * it would a file chosen through the picker -- no parallel upload path, no second code path on
 * the server. `input.files` is assignable from a DataTransfer's FileList in every browser this
 * app targets; it is NOT constructible in jsdom, so the assignment is guarded and its success is
 * reported rather than assumed. Returns false when the file could not be attached, which is the
 * caller's cue to say so instead of showing a filename the form will not actually send.
 */
export function attachDroppedFiles(input: HTMLInputElement | null, transfer: DataTransfer | null): boolean {
  if (input === null || transfer === null) return false;
  try {
    input.files = transfer.files;
    return input.files !== null && input.files.length > 0;
  } catch {
    return false;
  }
}

export interface FileDropProps {
  /** The form field name, exactly as a bare <input type="file"> would carry it. */
  name: string;
  accept: string;
  /** The input's accessible name. Rendered as its <label>. */
  label: string;
  /** Rendered OUTSIDE the label (item J): a hint inside one becomes part of the accessible name. */
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Called with whatever was accepted, from a drop or from the picker alike. */
  onFile?: (file: File) => void;
  /**
   * Whether to echo the chosen filename under the control. False where the browser's own file
   * input already shows it -- the import page reported it twice otherwise (owner screenshot,
   * 2026-09-13). A drop still needs it, because a dropped file's name does not always reach the
   * input's own label.
   */
  showChosenName?: boolean;
}

/**
 * A file input you can also drop onto.
 *
 * Every path through this component ends at the same <input type="file">: the click path IS the
 * input, and a drop assigns the input's own files. Nothing here uploads anything, and the form
 * around it posts exactly what it posted before.
 *
 * The drag handlers look fussier than they are. dragOver must preventDefault or the browser
 * navigates to the dropped file and the page is gone. dragEnter/dragLeave are counted rather than
 * treated as a boolean, because crossing any child element fires a leave immediately followed by
 * an enter -- a boolean flickers the highlight on every pixel of movement.
 */
export function FileDrop({
  name,
  accept,
  label,
  hint,
  required = false,
  disabled = false,
  className = '',
  onFile,
  showChosenName = true,
}: FileDropProps): React.ReactElement {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const extensions = extensionsFromAccept(accept);

  function take(file: File): void {
    setRefusal(null);
    setChosen(file.name);
    onFile?.(file);
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    if (disabled) return;
    // The FileList is snapshotted into a plain array before anything else touches it -- the same
    // trap ReceiptUploader documents: the underlying list is cleared out from under you the
    // moment the input's value is reset, and every later read then sees an empty list.
    const transfer = event.dataTransfer ?? null;
    const files: File[] = transfer === null ? [] : Array.from(transfer.files ?? []);
    const refused = rejectionFor(files, extensions);
    if (refused !== null) {
      setChosen(null);
      setRefusal(refused);
      return;
    }
    const attached = attachDroppedFiles(inputRef.current, transfer);
    if (!attached && typeof window !== 'undefined' && window.DataTransfer !== undefined) {
      // A real browser that would not take the file: say so rather than show a filename the
      // form will not send. (In jsdom there is no DataTransfer at all, and the tests drive the
      // component's own state, so this branch stays out of their way.)
      setChosen(null);
      setRefusal('This browser would not accept the dropped file. Use Choose a file instead.');
      return;
    }
    take(files[0]!);
  }

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div
        data-testid="file-drop"
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current += 1;
          if (!disabled) setOver(true);
        }}
        onDragOver={(event) => {
          // MUST prevent the default, or the browser opens the file and the page is lost.
          event.preventDefault();
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
          over ? 'border-accent bg-surface-2' : 'border-line'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          name={name}
          accept={accept}
          required={required}
          disabled={disabled}
          className="text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) {
              setChosen(null);
              return;
            }
            take(file);
          }}
        />
        <p className="text-xs text-muted">or drop it here</p>
        {chosen === null || !showChosenName ? null : <p className="text-sm text-ink">{chosen}</p>}
        {refusal === null ? null : (
          <p role="status" className="text-sm text-danger-text">
            {refusal}
          </p>
        )}
      </div>
      {hint === undefined ? null : <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
