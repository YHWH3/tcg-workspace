import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileUp, ImagePlus, Video } from 'lucide-react';
import { db, type LocalRow } from '../../../core/db';
import { addFile, useFileUrl, type FileRow } from '../../../core/files';
import { AudioPlayer, FileImage, FilePreview, Lightbox } from '../../../core/fileui';
import { RecordButton } from '../../../core/recorder';
import { mutate } from '../../../core/sync/engine';
import { debounce } from '../../../core/utils';
import { registerBlockType, type MediaBlockProps } from './registry';

function fileOf(block: LocalRow): string | undefined {
  return block.fileId ? String(block.fileId) : undefined;
}

/** Hidden file input that adds the picked file to this block. */
function useBlockUpload(block: LocalRow, accept: string, transcript = false) {
  const input = useRef<HTMLInputElement>(null);
  const pick = () => input.current?.click();
  const node = (
    <input
      ref={input}
      type="file"
      accept={accept}
      className="hidden"
      onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const fid = await addFile(f, { parentType: 'block', parentId: block.id, transcriptState: transcript ? 'pending' : undefined });
        await mutate('blocks', block.id, { fileId: fid });
      }}
    />
  );
  return { pick, node };
}

function Caption({ block }: { block: LocalRow }) {
  const [v, setV] = useState(String(block.caption ?? ''));
  const deb = useRef(debounce((t: string) => void mutate('blocks', block.id, { caption: t }), 400));
  return (
    <input
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        deb.current(e.target.value);
      }}
      onBlur={() => deb.current.flush(v)}
      placeholder="Add a caption…"
      className="mt-1 w-full bg-transparent px-1 text-center text-xs text-neutral-400 outline-none placeholder:text-neutral-300 focus:text-neutral-500 dark:placeholder:text-neutral-600"
    />
  );
}

function Empty({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 py-8 text-xs font-medium text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:text-neutral-300">
      {icon} {label}
    </button>
  );
}

function ImageBlock({ block }: MediaBlockProps) {
  const fileId = fileOf(block);
  const file = useLiveQuery(() => (fileId ? db.files.get(fileId) : undefined), [fileId]) as FileRow | undefined;
  const [open, setOpen] = useState(false);
  const up = useBlockUpload(block, 'image/*');
  if (!fileId) {
    return (
      <>
        {up.node}
        <Empty icon={<ImagePlus size={15} />} label="Add image" onClick={up.pick} />
      </>
    );
  }
  return (
    <figure className="py-1">
      {up.node}
      <button className="block w-full cursor-zoom-in" onClick={() => setOpen(true)}>
        <FileImage fileId={fileId} className="max-h-[480px] w-full rounded-lg object-contain" alt={String(block.caption ?? '')} />
      </button>
      <Caption block={block} />
      {open && file && <Lightbox files={[file]} startId={fileId} onClose={() => setOpen(false)} />}
    </figure>
  );
}

function VideoBlock({ block }: MediaBlockProps) {
  const fileId = fileOf(block);
  const file = useLiveQuery(() => (fileId ? db.files.get(fileId) : undefined), [fileId]) as FileRow | undefined;
  const up = useBlockUpload(block, 'video/*');
  if (!fileId) {
    return (
      <>
        {up.node}
        <Empty icon={<Video size={15} />} label="Add video" onClick={up.pick} />
      </>
    );
  }
  return (
    <div className="py-1">
      {up.node}
      {file && <VideoPlayer file={file} />}
      <Caption block={block} />
    </div>
  );
}

function VideoPlayer({ file }: { file: FileRow }) {
  const { url } = useFileUrl(file.id);
  if (!url) return <div className="flex h-24 items-center justify-center rounded-lg bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-800">Video not synced yet</div>;
  return <video src={url} controls playsInline className="max-h-[480px] w-full rounded-lg bg-black" />;
}

function AudioBlock({ block, onDelete }: MediaBlockProps) {
  const fileId = fileOf(block);
  const file = useLiveQuery(() => (fileId ? db.files.get(fileId) : undefined), [fileId]) as FileRow | undefined;
  if (!fileId) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-300 px-4 py-6 dark:border-neutral-700">
        <RecordButton
          onDone={async (blob) => {
            const fid = await addFile(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }), { parentType: 'block', parentId: block.id, transcriptState: 'pending' });
            await mutate('blocks', block.id, { fileId: fid });
          }}
          className="w-full justify-center py-2"
        />
        <span className="text-[11px] text-neutral-400">or pick an audio file</span>
        <AudioPick block={block} />
      </div>
    );
  }
  return (
    <div className="py-1">
      {file && <AudioPlayer file={file} onDelete={onDelete} />}
      <Caption block={block} />
    </div>
  );
}

function AudioPick({ block }: { block: LocalRow }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const fid = await addFile(f, { parentType: 'block', parentId: block.id });
          await mutate('blocks', block.id, { fileId: fid });
        }}
      />
      <button onClick={() => input.current?.click()} className="rounded-md px-2 py-1 text-[11px] text-neutral-500 underline-offset-2 hover:underline">
        browse
      </button>
    </>
  );
}

function FileBlock({ block }: MediaBlockProps) {
  const fileId = fileOf(block);
  const file = useLiveQuery(() => (fileId ? db.files.get(fileId) : undefined), [fileId]) as FileRow | undefined;
  const up = useBlockUpload(block, 'application/pdf,image/*,video/*,audio/*,*/*');
  if (!fileId) {
    return (
      <>
        {up.node}
        <Empty icon={<FileUp size={15} />} label="Add file or PDF" onClick={up.pick} />
      </>
    );
  }
  return (
    <div className="py-1">
      {up.node}
      {file && <FilePreview file={file} />}
      <Caption block={block} />
    </div>
  );
}

registerBlockType('image', 'Image', ImageBlock);
registerBlockType('video', 'Video', VideoBlock);
registerBlockType('audio', 'Voice memo', AudioBlock);
registerBlockType('file', 'File / PDF', FileBlock);
