// Pairing flow group. The full screens land in P03A (DM-style pairing code
// flow, Bonjour discovery, etc.). For P02A we only mount the group so the
// IA from `plan.md` §5 is visible.
import { Stack } from 'expo-router';

export default function PairingLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
