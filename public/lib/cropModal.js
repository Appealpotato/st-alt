/**
 * Opens a modal with Cropper.js to crop an image file.
 * Returns a Promise that resolves to a cropped File, or null if cancelled.
 *
 * @param {File} file        - The original image file
 * @param {object} [opts]    - Cropper options overrides
 * @param {number} [opts.aspectRatio] - Default 2/3 (portrait avatar)
 * @returns {Promise<File|null>}
 */
export function openCropModal(file, opts = {}) {
  return new Promise((resolve) => {
    const aspectRatio = opts.aspectRatio ?? 2 / 3;

    // Build modal DOM
    const overlay = document.createElement('div');
    overlay.className = 'crop-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'crop-modal';

    const imgContainer = document.createElement('div');
    imgContainer.className = 'crop-modal-img-container';

    const img = document.createElement('img');
    img.className = 'crop-modal-img';
    imgContainer.appendChild(img);

    const btnRow = document.createElement('div');
    btnRow.className = 'crop-modal-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.textContent = 'Crop';

    btnRow.append(cancelBtn, confirmBtn);
    modal.append(imgContainer, btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Load image
    const url = URL.createObjectURL(file);
    img.src = url;

    let cropper;
    img.addEventListener('load', () => {
      cropper = new window.Cropper(img, {
        aspectRatio,
        viewMode: 2,
        autoCropArea: 1,
        rotatable: false,
        background: false,
      });
    }, { once: true });

    function cleanup() {
      if (cropper) cropper.destroy();
      URL.revokeObjectURL(url);
      overlay.remove();
    }

    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup(); resolve(null); }
    });

    confirmBtn.addEventListener('click', () => {
      if (!cropper) return;
      const canvas = cropper.getCroppedCanvas();
      canvas.toBlob((blob) => {
        cleanup();
        const cropped = new File([blob], file.name, { type: 'image/png' });
        resolve(cropped);
      }, 'image/png');
    });
  });
}
