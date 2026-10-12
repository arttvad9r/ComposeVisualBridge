const $ = id => document.getElementById(id);
let current = 'fit';
export const getZoom = () => current;
export function syncZoom(scale) {
  $('zoomRange').value = Math.round(scale * 100);
  $('zoomRange').setAttribute('aria-valuetext', `${Math.round(scale * 100)}%`);
  $('zoomValue').textContent = `${Math.round(scale * 100)}%`;
}
export function setupZoom(onChange) {
  $('zoom').onchange = () => { current = $('zoom').value; onChange(); };
  $('zoomRange').oninput = () => {
    const percent = Number($('zoomRange').value), value = String(percent / 100);
    current = value;
    $('zoom').value = [...$('zoom').options].some(option => option.value === value) ? value : '';
    onChange();
  };
}
