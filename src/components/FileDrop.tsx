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

/** One file that could not be taken, and the same sentence `rejectionFor` would have given for it. */
export interface RejectedFile {
  file: File;
  reason: string;
}

/**
 * 2026-09-15. The multi-file counterpart of `rejectionFor`, and deliberately a DIFFERENT SHAPE
 * rather than a relaxation of it.
 *
 * `rejectionFor` answers "may this drop proceed?" with one sentence, which is the right question
 * when exactly one file may land. For many files it is the wrong question: the realistic drop is a
 * bank folder holding nine statements and a PDF, and refusing all ten because of the one would be
 * worse than the one-at-a-time flow it replaces. So this partitions instead of judging, and the
 * caller imports the good ones while saying what it skipped -- which is what was asked for
 * (an unsupported file should be handled gracefully rather than refusing the drop).
 *
 * The per-file reason is `rejectionFor`'s own sentence, so both modes refuse a .pdf in the same
 * words.
 */
export function partitionDrop(
  files: readonly File[],
  extensions: string[],
): { accepted: File[]; rejected: RejectedFile[] } {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  for (const file of files) {
    const reason = rejectionFor([file], extensions);
    if (reason === null) accepted.push(file);
    else rejected.push({ file, reason });
  }
  return { accepted, rejected };
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
   * Take more than one file. Off by default: every caller in the app but the batch import screen
   * lands exactly one file, and `rejectionFor` refusing a two-file drop is a real guard for them.
   */
  multiple?: boolean;
  /**
   * The multi counterpart of `onFile`, called with the ACCEPTED files only -- see `partitionDrop`
   * for why the rejects do not cancel the rest. Only ever called when `multiple` is set.
   */
  onFiles?: (files: File[]) => void;
  /**
   * Whether to echo the chosen filename under the control. Default true, and there is now no
   * reason for any caller to turn it off: the native input is visually hidden (see the render
   * below), so this is the ONLY place a filename appears. It was added when the browser's own
   * widget printed the name as well and the import page showed it twice (reported,
   * 2026-09-13); the prop survives because a caller that shows the name in its own summary line
   * may still legitimately not want it repeated here.
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
  multiple = false,
  onFiles,
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

  /**
   * The multi path. Deliberately does NOT attach anything to the input: a drop's own FileList
   * holds the rejects too, and there is no way to build a filtered one that every target browser
   * accepts. A multi caller reads `onFiles` and posts the array itself, so the input's list is not
   * the source of truth the way it is for the single, form-posting path above.
   */
  function takeMany(files: File[]): void {
    const { accepted, rejected } = partitionDrop(files, extensions);
    if (files.length === 0) {
      setChosen(null);
      setRefusal('That drop carried no file.');
      return;
    }
    setRefusal(
      rejected.length === 0
        ? null
        : `Skipped ${orList(rejected.map((entry) => entry.file.name))} — ${
            extensions.length === 0 ? 'not a file this page reads' : `only ${orList(extensions)} files can be read here`
          }.`,
    );
    setChosen(accepted.length === 0 ? null : `${accepted.length} ${accepted.length === 1 ? 'file' : 'files'}`);
    if (accepted.length > 0) onFiles?.(accepted);
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
    if (multiple) {
      takeMany(files);
      return;
    }
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
        // focus-within, because the input that takes focus is visually hidden: without this a
        // keyboard user tabbing onto the control would see nothing move at all.
        className={`flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors focus-within:border-accent ${
          over ? 'border-accent bg-surface-2' : 'border-line'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        {/*
          VISUALLY HIDDEN, NOT HIDDEN. `sr-only` keeps the input in the tab order, keeps it the
          element a screen reader announces, and keeps its <label> association intact -- `hidden`,
          `display: none` or `disabled` would each take the keyboard path away, and the keyboard
          path is the real one this component only decorates.

          It is hidden because a file input's button is drawn by the operating system and cannot be
          styled at all: on this app's dark surface it renders as a pale grey "Choose File / No
          file chosen" rectangle that matches nothing around it, and it prints its own filename
          beside our own. Reported directly, twice (2026-09-13 and again on v1.38.0).
          The label below is the button instead.
        */}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          name={name}
          accept={accept}
          multiple={multiple}
          required={required}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            if (multiple) {
              takeMany(Array.from(event.target.files ?? []));
              return;
            }
            const file = event.target.files?.[0];
            if (file === undefined) {
              setChosen(null);
              return;
            }
            take(file);
          }}
        />
        {/* The input's own <label>, styled as the button -- so the click target, the accessible
            name and the visible control are one element rather than three that have to agree. */}
        <label
          htmlFor={inputId}
          className={`btn btn--secondary btn--sm ${disabled ? 'pointer-events-none' : 'cursor-pointer'}`}
        >
          {label}
        </label>
        <p className="text-xs text-muted">or drop it here</p>
        {chosen === null || !showChosenName ? null : (
          <p className="text-sm text-ink" data-testid="file-drop-chosen">
            {chosen}
          </p>
        )}
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
