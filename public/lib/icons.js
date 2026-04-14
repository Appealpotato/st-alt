import {
  Pencil, Trash2, GitBranch, RefreshCw,
  ChevronLeft, ChevronRight, X, Plus,
  Settings2, Users, Layers, MessageSquare,
  LayoutGrid, AlignLeft, AlignCenter, AlignRight, AlignJustify, Copy, Check,
  Maximize2, Minimize2, List, Download,
  Play, Upload, MessageSquarePlus, Package, ListChecks,
} from './lucide.js';

export {
  Pencil, Trash2, GitBranch, RefreshCw,
  ChevronLeft, ChevronRight, X, Plus,
  Settings2, Users, Layers, MessageSquare,
  LayoutGrid, AlignLeft, AlignCenter, AlignRight, AlignJustify, Copy, Check,
  Maximize2, Minimize2, List, Download,
  Play, Upload, MessageSquarePlus, Package, ListChecks,
};

/**
 * icon(iconNode, size?) — returns a configured <svg> DOM element.
 * iconNode is a Lucide named export (array of [tag, attrs] child specs).
 */
export function icon(iconNode, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  svg.style.flexShrink = '0';
  for (const [tag, attrs] of iconNode) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}
