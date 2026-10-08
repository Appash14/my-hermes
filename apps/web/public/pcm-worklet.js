/**
 * Convertit l'audio du micro en PCM 16 bits signé, le format attendu par
 * Deepgram.
 *
 * Le rééchantillonnage vers 16 kHz n'est pas fait ici : l'AudioContext est
 * créé directement à 16 kHz côté client, et le navigateur s'en charge —
 * son rééchantillonneur est bien meilleur que ce qu'on écrirait ici.
 */
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      // Clamp avant conversion : au-delà de ±1 le cast déborderait et
      // produirait un crachotement au lieu d'une saturation propre.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    // Transfert du buffer plutôt que copie : évite une allocation par trame.
    this.port.postMessage(pcm, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
