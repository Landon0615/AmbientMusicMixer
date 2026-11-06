/* Wwise-style voice filters for the preview: first-order (6 dB/octave) high-pass then low-pass, cutoffs in Hz
   (the page converts Wwise LPF/HPF units 0-100 with Audiokinetic's published table). 0 Hz = bypass.
     LP: y[n] = (1-b) x[n] + b y[n-1]                    b = exp(-2 pi fc / fs)
     HP: y[n] = a0 (x[n] - x[n-1]) + b y[n-1]            a0 = (1 + b) / 2
   Wwise does not document the slope of its voice filters; first order is the assumption (see NOTES.md). */
class AmOnePole extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'lp', defaultValue: 0, minValue: 0, maxValue: 24000, automationRate: 'k-rate' },
            { name: 'hp', defaultValue: 0, minValue: 0, maxValue: 24000, automationRate: 'k-rate' }];
  }
  constructor() { super(); this.ly = [0, 0]; this.hx = [0, 0]; this.hy = [0, 0]; }
  process(inputs, outputs, params) {
    var inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    var lp = params.lp[0], hp = params.hp[0], n = out[0].length;
    var useLp = lp > 0 && lp < 20000, useHp = hp > 0;
    var bl = useLp ? Math.exp(-2 * Math.PI * lp / sampleRate) : 0;
    var bh = useHp ? Math.exp(-2 * Math.PI * hp / sampleRate) : 0, ah = (1 + bh) / 2;
    for (var c = 0; c < out.length; c++) {
      var x = inp && inp.length ? inp[c < inp.length ? c : 0] : null, y = out[c], k = c < 2 ? c : 1;
      var ly = this.ly[k], hx = this.hx[k], hy = this.hy[k];
      for (var i = 0; i < n; i++) {
        var s = x ? x[i] : 0;
        if (useHp) { var h = ah * (s - hx) + bh * hy; hx = s; hy = h; s = h; } else { hx = s; hy = 0; }
        if (useLp) { ly = (1 - bl) * s + bl * ly; s = ly; } else ly = s;
        y[i] = s;
      }
      this.ly[k] = ly; this.hx[k] = hx; this.hy[k] = hy;
    }
    return true;
  }
}
registerProcessor('am-onepole', AmOnePole);
