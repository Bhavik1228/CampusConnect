import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';

export const colors = {
  navy: '#10152B',
  navyLight: '#202847',
  violet: '#326B57',
  violetLight: '#E8F1EB',
  white: '#FFFFFF',
  canvas: '#F6F7FB',
  text: '#182033',
  muted: '#687185',
  border: '#E2E5ED',
  danger: '#B42318',
  dangerBg: '#FEF3F2',
  success: '#067647',
  successBg: '#ECFDF3',
};

export function Page({ title, subtitle, children, scroll = true }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
}) {
  const content = <>
    <ConnectivityBanner />
    <View style={styles.pageHeading}>
      <Text style={styles.pageTitle}>{title}</Text>
      {subtitle ? <Text style={styles.pageSubtitle}>{subtitle}</Text> : null}
    </View>
    {children}
  </>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {scroll
        ? <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">{content}</ScrollView>
        : <View style={styles.pageContent}>{content}</View>}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ children }: { children: string }) {
  return <Text style={styles.sectionHeading}>{children}</Text>;
}

export function BodyText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.bodyText, muted && styles.mutedText]}>{children}</Text>;
}

export function Field({ label, inputStyle, ...props }: TextInputProps & { label: string; inputStyle?: object }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor="#8A91A3"
        style={[styles.input, props.multiline && styles.multiline, inputStyle]}
        accessibilityLabel={label}
        {...props}
      />
    </View>
  );
}

export function Button({ title, onPress, disabled = false, variant = 'primary' }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.secondaryButton,
        variant === 'danger' && styles.dangerButton,
        disabled && styles.disabledButton,
        focused && !disabled && styles.focusedButton,
        pressed && !disabled && styles.pressedButton,
      ]}>
      <Text style={[styles.buttonText, variant === 'secondary' && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <View style={styles.loading}><ActivityIndicator color={colors.violet} /><Text style={styles.mutedText}>{label}</Text></View>;
}

export function Message({ children, variant = 'info' }: { children: string; variant?: 'info' | 'error' | 'success' }) {
  const colorStyle = variant === 'error' ? styles.errorMessage : variant === 'success' ? styles.successMessage : styles.infoMessage;
  return <Text accessibilityRole="alert" style={[styles.message, colorStyle]}>{children}</Text>;
}

export function ConnectivityBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => setOffline(state.isConnected === false));
    return unsubscribe;
  }, []);
  if (!offline) return null;
  return <Text accessibilityRole="alert" style={styles.offlineBanner}>Offline - protected actions need an internet connection.</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  pageContent: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28, gap: 14 },
  pageHeading: { gap: 5, marginTop: 6, marginBottom: 2 },
  pageTitle: { color: colors.text, fontSize: 26, fontWeight: '800' },
  pageSubtitle: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: colors.white, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 },
  sectionHeading: { color: colors.text, fontSize: 17, fontWeight: '700' },
  bodyText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  mutedText: { color: colors.muted },
  field: { gap: 6 },
  fieldLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, backgroundColor: colors.white, fontSize: 15 },
  multiline: { minHeight: 92, textAlignVertical: 'top' },
  button: { minHeight: 46, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'transparent', borderRadius: 12, backgroundColor: colors.violet, paddingHorizontal: 16, paddingVertical: 12 },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  secondaryButton: { backgroundColor: colors.violetLight, borderWidth: 1, borderColor: '#D9D0FF' },
  secondaryButtonText: { color: '#5037CC' },
  dangerButton: { backgroundColor: colors.danger },
  disabledButton: { opacity: 0.48 },
  focusedButton: { borderColor: colors.text },
  pressedButton: { opacity: 0.8 },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  message: { borderRadius: 10, padding: 12, fontSize: 14, lineHeight: 20, overflow: 'hidden' },
  errorMessage: { color: colors.danger, backgroundColor: colors.dangerBg },
  successMessage: { color: colors.success, backgroundColor: colors.successBg },
  infoMessage: { color: '#4338A8', backgroundColor: colors.violetLight },
  offlineBanner: { backgroundColor: '#FFF4E5', color: '#8A4B00', padding: 10, borderRadius: 9, fontSize: 14, lineHeight: 20 },
});
