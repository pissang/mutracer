import { useRef, useState } from 'react';
import {
  Button, Dialog, DialogTrigger, Heading, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Separator
} from 'react-aria-components';
import {
  ChevronDown, Code2, Download, FileUp, Folder, Globe, HelpCircle, Link, MoreHorizontal, PanelLeft, PanelRight, Redo2, RotateCcw, Undo2, Upload, X
} from 'lucide-react';
import { setUi, useViewer } from '../store';
import { getEngine } from '../engine/ViewerEngine';
import { toPathedFiles } from '../engine/loadModel';
import { redo, undo } from '../history';
import { BrandMark } from './BrandMark';
import { ExamplesMenu } from './ExamplesBrowser';

export function Toolbar({ mobile }: { mobile: boolean }) {
  const backend = useViewer((s) => s.backend);
  const ui = useViewer((s) => s.ui);
  const developmentVersion = location.hostname === 'mutracer-dev.meimu-studio.com'
    || (location.hostname.startsWith('mutracer-dev.') && location.hostname.endsWith('.workers.dev'));
  return (
    <header className="header">
      <div className="brand">
        <a className="brand__home" href="../" title="MuTracer home">
          <BrandMark />
          <span className="brand__name">
            <strong>{mobile ? 'MuTracer' : 'MuTracer Viewer'}</strong>
            {developmentVersion && <span className="brand__version" title="This is a development version.">
              {mobile ? 'Development' : 'Development version'}
            </span>}
          </span>
        </a>
        <span className="divider hide-m" />
        <button className="icon-btn icon-btn--bare sm hide-m" aria-label="Toggle scene panel" title="Toggle scene panel ([)"
          aria-pressed={ui.left} onClick={() => setUi({ left: !ui.left })}><PanelLeft size={15} /></button>
      </div>
      <div className="header__center">
        <OpenMenu />
        <ExamplesMenu mobile={mobile} />
      </div>
      <div className="header__right">
        <HistoryButtons />
        {!mobile && <><span className="divider" /><ResetButton /></>}
        <BackendMenu name={backend.name} adapter={backend.adapter} />
        <a className="icon-btn icon-btn--bare hide-m" href="https://github.com/pissang/mutracer" target="_blank" rel="noopener noreferrer"
          aria-label="MuTracer on GitHub (opens in a new tab)" title="MuTracer on GitHub">
          {/* GitHub Octicons mark-github-16 (MIT): https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
          </svg>
        </a>
        <HelpButton />
        {!mobile && <button className="btn" aria-label="Show code" title="Show code" onClick={() => setUi({ codeOpen: true })}>
          <Code2 size={15} /><span className="hide-xs">Code</span>
        </button>}
        {mobile && <MobileActionsMenu />}
        <button className="btn btn--primary" aria-label="Export image" onClick={() => setUi({ exportOpen: true })}>
          <Download size={15} /><span className="hide-xs">Export</span>
        </button>
        <button className="icon-btn icon-btn--bare sm hide-m" aria-label="Toggle inspector" title="Toggle inspector (])"
          aria-pressed={ui.right} onClick={() => setUi({ right: !ui.right })}><PanelRight size={15} /></button>
      </div>
    </header>
  );
}

function HistoryButtons() {
  const history = useViewer((s) => s.history);
  return (
    <div className="history-btns">
      <button className="icon-btn icon-btn--bare sm" aria-label="Undo" disabled={!history.undo} onClick={undo}
        title={history.undo ? `Undo ${history.undo} (⌘Z)` : 'Undo (⌘Z)'}><Undo2 size={15} /></button>
      <button className="icon-btn icon-btn--bare sm" aria-label="Redo" disabled={!history.redo} onClick={redo}
        title={history.redo ? `Redo ${history.redo} (⇧⌘Z)` : 'Redo (⇧⌘Z)'}><Redo2 size={15} /></button>
    </div>
  );
}

function ResetButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn icon-btn--bare sm" aria-label="Reset all" title="Reset all"
        onClick={() => setOpen(true)}><RotateCcw size={15} /></button>
      <ResetDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function MobileActionsMenu() {
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <>
      <MenuTrigger>
        <Button className="icon-btn" aria-label="More actions"><MoreHorizontal size={18} /></Button>
        <Popover className="popover menu" offset={8} placement="bottom end" style={{ width: 220 }}>
          <Menu className="menu-list" aria-label="More actions" onAction={(key) => {
            if (key === 'code') setUi({ codeOpen: true });
            if (key === 'reset') setResetOpen(true);
          }}>
            <MenuItem id="code" className="menu-item"><Code2 size={15} />Show code</MenuItem>
            <MenuItem id="reset" className="menu-item"><RotateCcw size={15} />Reset all…</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <ResetDialog open={resetOpen} onOpenChange={setResetOpen} />
    </>
  );
}

function ResetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <ModalOverlay className="scrim" isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="dialog">
        <Dialog role="alertdialog" aria-label="Reset all">
          {({ close }) => (
            <>
              <Heading slot="title" className="dialog__title">Reset all?</Heading>
              <p className="hint">Lighting, render settings, materials and object visibility return to their defaults, and the camera frames the model again. You can undo this, except for the camera.</p>
              <div className="actions">
                <button type="button" className="btn" autoFocus onClick={close}>Cancel</button>
                <button type="button" className="btn btn--danger" onClick={() => { getEngine()?.resetAll(); close(); }}>Reset all</button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function OpenMenu() {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const hdr = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const onFiles = (list: FileList | null) => list?.length && void getEngine()?.loadFiles(toPathedFiles(list));
  return (
    <>
      <MenuTrigger>
        <Button className="btn" aria-label="Open"><Upload size={15} /><span className="hide-xs">Open</span><ChevronDown size={13} className="chev" /></Button>
        <Popover className="popover menu" offset={8} style={{ width: 250 }}>
          <Menu className="menu-list" aria-label="Open" onAction={(key) => {
            if (key === 'files') files.current?.click();
            if (key === 'folder') folder.current?.click();
            if (key === 'hdr') hdr.current?.click();
            if (key === 'url') setUrlOpen(true);
          }}>
            <MenuItem id="files" className="menu-item"><FileUp size={15} />Open files…<kbd>⌘O</kbd></MenuItem>
            <MenuItem id="folder" className="menu-item"><Folder size={15} />Open folder…<kbd /></MenuItem>
            <MenuItem id="url" className="menu-item"><Link size={15} />Open from URL…<kbd /></MenuItem>
            <Separator className="menu-sep" />
            <MenuItem id="hdr" className="menu-item"><Globe size={15} />Load environment (.hdr)…<kbd /></MenuItem>
          </Menu>
          <div className="menu-note">Or drop files anywhere on the viewport.</div>
        </Popover>
      </MenuTrigger>
      <input ref={files} id="open-files" type="file" hidden multiple accept=".glb,.gltf,.pbrt,.gz,.ply,.bin,.png,.jpg,.jpeg,.webp,.ktx2,.hdr,.exr,.tga,.tif,.tiff,.spd" onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <input ref={folder} type="file" hidden {...{ webkitdirectory: '' }} onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <input ref={hdr} type="file" hidden accept=".hdr" onChange={(e) => { onFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
      <UrlDialog open={urlOpen} onOpenChange={setUrlOpen} />
    </>
  );
}

function UrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState('');
  return (
    <ModalOverlay className="scrim" isOpen={open} onOpenChange={onOpenChange} isDismissable>
      <Modal className="dialog">
        <Dialog aria-label="Open from URL">
          {({ close }) => (
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim()) return;
              void getEngine()?.loadUrl(url.trim());
              close();
            }}>
              <Heading slot="title" className="dialog__title">Open from URL
                <button type="button" className="icon-btn icon-btn--bare sm" aria-label="Close" onClick={close}><X size={14} /></button>
              </Heading>
              <input className="text-input" autoFocus placeholder="https://…/scene.pbrt, model.glb or environment.hdr" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
              <p className="hint">The server must allow cross-origin requests. .gltf and .pbrt files load resources relative to the scene URL.</p>
              <div className="actions">
                <button type="button" className="btn" onClick={close}>Cancel</button>
                <button type="submit" className="btn btn--primary" disabled={!url.trim()}>Open</button>
              </div>
            </form>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function BackendMenu({ name, adapter }: { name: string | null; adapter: string }) {
  const webgl = name === 'WebGL 2';
  return (
    <MenuTrigger>
      <Button className="backend-pill hide-m" aria-label="Rendering backend">
        <i className="dot" data-tone={webgl ? 'warn' : name ? 'ok' : 'idle'} />
        <b>{name ?? 'Starting'}</b>{adapter && <span className="adapter">· {adapter}</span>}
      </Button>
      <Popover className="popover menu" offset={8} placement="bottom end" style={{ width: 260 }}>
        <Menu className="menu-list" aria-label="Backend" onAction={(key) => {
          const url = new URL(location.href);
          if (key === 'webgl') url.searchParams.set('webgl', '');
          else url.searchParams.delete('webgl');
          location.href = url.toString();
        }}>
          <MenuItem id="webgpu" className="menu-item">WebGPU<kbd>{!webgl && name ? 'active' : ''}</kbd></MenuItem>
          <MenuItem id="webgl" className="menu-item">WebGL 2 fallback<kbd>{webgl ? 'active' : ''}</kbd></MenuItem>
        </Menu>
        <div className="menu-note">Switching reloads the page. OIDN and auto exposure need WebGPU.</div>
      </Popover>
    </MenuTrigger>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Drag / right-drag / scroll', 'Orbit / pan / zoom'],
  ['Click', 'Select object'],
  ['F', 'Fit to model'],
  ['Space', 'Play or pause'],
  ['D', 'Toggle denoiser'],
  ['E', 'Export image'],
  ['1 – 4', 'Inspector tabs'],
  ['[  ]', 'Scene / inspector panels'],
  ['H', 'Hide interface'],
  ['⌘Z  ⇧⌘Z', 'Undo / redo material, lighting and render edits'],
  ['⌘O', 'Open files']
];

function HelpButton() {
  return (
    <DialogTrigger>
      <Button className="icon-btn icon-btn--bare hide-m" aria-label="Keyboard shortcuts"><HelpCircle size={16} /></Button>
      <Popover className="popover" offset={8} placement="bottom end">
        <Dialog aria-label="Keyboard shortcuts" className="shortcuts">
          <h4>Shortcuts</h4>
          <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
