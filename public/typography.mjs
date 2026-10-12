// Native curve stores hundredths of dp for 0, 0.5, …, 150 sp.
export function scaledSp(value, scale = 1, curve) {
  if (!curve || Math.abs(value) > 150) return value * scale;
  const index = Math.abs(value) * 2, lower = Math.floor(index), upper = Math.min(300, lower + 1);
  return Math.sign(value) * (curve[lower] + (curve[upper] - curve[lower]) * (index - lower)) / 100;
}

// Select the unmodified bundled Android font by its captured system file hash.
export function robotoFamily(hash) {
  return hash === 'd5633ff957d2ecb1ce7716e86e11057091c3526042efe16fe1f65dfc06a65551' ? 'Roboto 3.015' : 'Roboto';
}
