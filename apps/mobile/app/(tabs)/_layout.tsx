// Tabs layout. Real icons and labels land alongside the per-feature plans
// (Home → P05A, Threads → P06A, Agents → P07A, Voice → P08A, Settings → P09A).
// For P02A we register each tab so the IA is visible end-to-end.
import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="threads" options={{ title: 'Threads' }} />
      <Tabs.Screen name="agents" options={{ title: 'Agents' }} />
      <Tabs.Screen name="voice" options={{ title: 'Voice' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
