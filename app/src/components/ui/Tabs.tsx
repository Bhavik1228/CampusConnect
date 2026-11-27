import * as React from 'react';

interface TabsProps {
  children: React.ReactNode;
  className?: string;
}

export function Tabs({ children, className = '', ...props }: TabsProps) {
  return <div role="tablist" className={`tabs ${className}`} {...props}>{children}</div>;
}

interface TabListProps {
  children: React.ReactNode;
  className?: string;
}

export function TabList({ children, className = '', ...props }: TabListProps) {
  return <div className={`tab-list ${className}`} {...props}>{children}</div>;
}

interface TabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function Tab({ selected = false, className = '', ...props }: TabProps) {
  return (
    <button
      role="tab"
      aria-selected={selected}
      className={`tab${selected ? ' tab-active' : ''} ${className}`}
      {...props}
    />
  );
}

interface TabPanelProps {
  children: React.ReactNode;
  className?: string;
}

export function TabPanel({ children, className = '', ...props }: TabPanelProps) {
  return <div role="tabpanel" className={`tab-panel ${className}`} {...props}>{children}</div>;
}
