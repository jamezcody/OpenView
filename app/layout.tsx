import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenView',
  applicationName: 'OpenView',
  icons: { icon: '/OpenView.ico', apple: '/OpenView_logo.png' },
  description:
    'Explore an interactive 3D globe with predicted satellite orbits, map layers, public property records, and regional live air and sea traffic.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
