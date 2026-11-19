import {
  HANDOFF_HASH, isHDRFile, isModelFile, readDroppedItems, stashFiles, toPathedFiles, type PathedFile
} from '../../viewer/src/engine/droppedFiles';
import { MODEL_PRESETS } from '../../viewer/src/engine/presets';
import './style.css';

const copyInstall = document.getElementById('copy-install') as HTMLButtonElement;
const installCommand = document.getElementById('install-command')!;
const copyStatus = document.getElementById('copy-install-status')!;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
copyInstall.addEventListener('click', async () => {
  clearTimeout(copyFeedbackTimer);
  copyInstall.disabled = true;
  delete copyInstall.dataset.copied;
  copyStatus.textContent = '';
  try {
    await navigator.clipboard.writeText(installCommand.textContent!.trim());
    copyInstall.dataset.copied = '';
    copyStatus.textContent = 'Copied!';
  } catch {
    copyStatus.textContent = 'Could not copy. Select the command to copy it manually.';
  } finally {
    copyInstall.disabled = false;
    copyFeedbackTimer = setTimeout(() => {
      delete copyInstall.dataset.copied;
      copyStatus.textContent = '';
    }, 3000);
  }
});

const drop = document.getElementById('drop')!;
const veil = document.getElementById('veil')!;
const error = document.getElementById('drop-error')!;

function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}

async function open(files: PathedFile[]) {
  if (!files.some((f) => isModelFile(f.path) || isHDRFile(f.path))) {
    showError('No .glb, .gltf or .hdr file found.');
    return;
  }
  drop.dataset.busy = '';
  try {
    await stashFiles(files);
    location.href = `./viewer/#${HANDOFF_HASH}`;
  } catch (e) {
    delete drop.dataset.busy;
    showError(`Could not hand the files to the viewer: ${(e as Error).message}. Open the viewer and drop them there.`);
  }
}

// The whole window accepts drops; the veil keeps dragleave from firing on child elements.
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  veil.hidden = false;
  drop.dataset.dragging = '';
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
veil.addEventListener('dragleave', () => {
  veil.hidden = true;
  delete drop.dataset.dragging;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  veil.hidden = true;
  delete drop.dataset.dragging;
  error.hidden = true;
  // Read the items before awaiting: the DataTransfer is cleared after the event.
  await open(await readDroppedItems(e.dataTransfer!.items));
});

for (const id of ['pick-files', 'pick-folder']) {
  const input = document.getElementById(id) as HTMLInputElement;
  input.addEventListener('change', () => {
    error.hidden = true;
    if (input.files?.length) void open(toPathedFiles(input.files));
    input.value = '';
  });
}

// The 55 procedural MaterialX samples bundled with the viewer, as a swatch wall.
const SWATCHES = import.meta.glob<string>('../../viewer/src/assets/thumbnails/materialx-*.webp', { eager: true, query: '?url', import: 'default' });
const swatches = document.getElementById('swatches')!;
for (const [path, url] of Object.entries(SWATCHES)) {
  const id = path.slice(path.lastIndexOf('/materialx-') + 11, -'.webp'.length);
  const label = id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.src = url;
  img.alt = label;
  img.title = label;
  img.width = img.height = 128;
  img.loading = 'lazy';
  img.decoding = 'async';
  li.append(img);
  swatches.append(li);
}

// Gallery tiles: which preset to show and the feature it demonstrates.
const GALLERY: { id: string; feature: string; size?: 'wide' | 'big' }[] = [
  { id: 'porsche-992-gt3-r', feature: 'Car paint and clear coat', size: 'big' },
  { id: 'super-human', feature: 'Subsurface skin' },
  { id: 'crystal-lens', feature: 'Spectral dispersion' },
  { id: 'gelatinous-cube', feature: 'Transmission and volume', size: 'wide' },
  { id: 'bugatti-chiron', feature: '4.6 M triangles, interactive' },
  { id: 'yamaha-mt-09', feature: 'Metals and coat' },
  { id: 'blender-cover-remix', feature: 'Full scene, characters', size: 'wide' },
  { id: 'meet-mat', feature: 'Layered materials' },
  { id: 'fluted-crystal', feature: 'Volume absorption' },
  { id: 'sheenchair', feature: 'Fuzz' },
  { id: 'toycar', feature: 'Coat and transmission' }
];
const bento = document.getElementById('bento')!;
for (const item of GALLERY) {
  const preset = MODEL_PRESETS.find((p) => p.id === item.id);
  if (!preset?.thumbnail) continue;
  const li = document.createElement('li');
  li.className = 'tile' + (item.size ? ` tile--${item.size}` : '');
  const a = document.createElement('a');
  a.className = 'tile__link';
  a.href = `./viewer/#model=${encodeURIComponent(preset.id)}`;
  const img = document.createElement('img');
  img.src = preset.thumbnail;
  img.alt = `${preset.name} rendered in MuTracer`;
  img.loading = 'lazy';
  img.decoding = 'async';
  const caption = document.createElement('span');
  caption.className = 'tile__caption';
  const feature = document.createElement('strong');
  feature.textContent = item.feature;
  const name = document.createElement('span');
  name.textContent = preset.name;
  caption.append(feature, name);
  a.append(img, caption);
  const credit = document.createElement('small');
  credit.className = 'tile__credit';
  const author = document.createElement('a');
  author.href = preset.sourceUrl;
  author.textContent = preset.credit;
  credit.append(author);
  if (preset.licenseUrl) {
    const terms = document.createElement('a');
    terms.href = preset.licenseUrl;
    terms.textContent = preset.license;
    credit.append(' · ', terms);
  } else {
    credit.append(` · ${preset.license}`);
  }
  for (const link of credit.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  li.append(a, credit);
  bento.append(li);
}

const cards = document.getElementById('cards')!;
const researchCards = document.getElementById('research-cards')!;
const examples = document.getElementById('scenes')!;
const collectionTabs = Array.from(examples.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
for (const tab of collectionTabs) {
  tab.addEventListener('click', () => {
    for (const candidate of collectionTabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      document.getElementById(candidate.getAttribute('aria-controls')!)!.hidden = !selected;
    }
  });
  tab.addEventListener('keydown', (event) => {
    const index = collectionTabs.indexOf(tab);
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % collectionTabs.length; break;
      case 'ArrowLeft': next = (index - 1 + collectionTabs.length) % collectionTabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = collectionTabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    collectionTabs[next].focus();
    collectionTabs[next].click();
  });
}

for (const preset of MODEL_PRESETS) {
  // Scenes built in code without a published thumbnail are reachable from the viewer.
  if (preset.id === 'spheres' || !preset.thumbnail) continue;
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = `./viewer/#model=${encodeURIComponent(preset.id)}`;
  const thumb = document.createElement('div');
  thumb.className = 'card__thumb';
  if (preset.thumbnail) {
    const img = document.createElement('img');
    img.src = preset.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }
  const name = document.createElement('strong');
  name.textContent = preset.name;
  const meta = document.createElement('small');
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = preset.tag;
  meta.append(tag);
  const info = [
    !preset.licenseUrl ? (preset.url ? preset.license : 'Procedural') : '',
    preset.sizeMB ? `${preset.sizeMB} MB` : ''
  ].filter(Boolean).join(' · ');
  if (info) {
    const detail = document.createElement('span');
    detail.textContent = info;
    meta.append(detail);
  }
  a.append(thumb, name, meta);
  li.append(a);
  if (preset.licenseUrl) {
    const credits = document.createElement('div');
    credits.className = 'card-credits';
    const author = document.createElement('a');
    author.href = preset.sourceUrl;
    author.textContent = preset.credit;
    const terms = document.createElement('a');
    terms.href = preset.licenseUrl;
    terms.textContent = preset.license;
    for (const link of [author, terms]) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    credits.append(author, terms);
    if (preset.attributionUrl) {
      const details = document.createElement('a');
      details.href = preset.attributionUrl;
      details.textContent = 'Credits & changes';
      details.target = '_blank';
      details.rel = 'noopener noreferrer';
      credits.append(details);
    }
    li.append(credits);
  }
  (preset.category === 'research' ? researchCards : cards).append(li);
}

// Tilt the hovered card toward the pointer; CSS applies it only for hover-capable,
// motion-tolerant users.
const tiltQuery = matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)');
const MAX_TILT_DEG = 8;
examples.addEventListener('pointermove', (event) => {
  const card = (event.target as Element).closest<HTMLElement>('.card');
  if (!card || !tiltQuery.matches || event.pointerType !== 'mouse') return;
  const rect = card.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  card.classList.add('is-tilting');
  card.style.setProperty('--rx', `${((0.5 - y) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
  card.style.setProperty('--ry', `${((x - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
  // Pan the thumbnail against the tilt so the image reads as sitting behind the card.
  card.style.setProperty('--px', ((x - 0.5) * 2).toFixed(3));
  card.style.setProperty('--py', ((y - 0.5) * 2).toFixed(3));
});
examples.addEventListener('pointerout', (event) => {
  const card = (event.target as Element).closest<HTMLElement>('.card');
  if (!card || card.contains(event.relatedTarget as Node | null)) return;
  card.classList.remove('is-tilting');
  for (const name of ['--rx', '--ry', '--px', '--py']) card.style.removeProperty(name);
});
