/**
 * Creates an accordion section.
 *
 * @param {string}  label     — Section header text
 * @param {boolean} startOpen — Whether section is expanded initially (default: true)
 * @returns {{ section: HTMLElement, body: HTMLElement }}
 *   section = the wrapper element to append to the DOM
 *   body    = the content container to fill with your UI
 */
export function createAccordion(label, startOpen = true) {
  const section = document.createElement('div');
  section.className = 'accordion-section' + (startOpen ? '' : ' collapsed');

  const header = document.createElement('div');
  header.className = 'accordion-header';
  header.innerHTML = `
    <span class="accordion-label">${label}</span>
    <span class="accordion-chevron">▾</span>
  `;

  const body = document.createElement('div');
  body.className = 'accordion-body';

  header.addEventListener('click', () => section.classList.toggle('collapsed'));

  section.appendChild(header);
  section.appendChild(body);

  return { section, body };
}
