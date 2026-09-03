import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://ruleripple.krharsh89.chatgpt.site'),
  title: 'RuleRipple — Policy decisions, made visible',
  description:
    'A deterministic policy control plane where agents propose changes, RuleRipple simulates their impact, and humans approve policy and execution.',
  openGraph: {
    title: 'RuleRipple — Policy decisions, made visible',
    description: 'Let agents propose, see every policy ripple, and keep humans in control.',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'RuleRipple policy simulation workspace' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RuleRipple — Policy decisions, made visible',
    description: 'Let agents propose, see every policy ripple, and keep humans in control.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
