// Root layout for the Expo Router app. Per `plan.md` §6, this is where
// CopilotKit / GatewayProvider / theme / query client wrap the route tree —
// but those land in P03A+. For P02A we only need a working Stack so the
// pairing flow and the tabs nav both have a root to mount under.
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(pairing)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
