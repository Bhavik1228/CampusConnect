import * as React from 'react';

type HeadingTag = 'h1' | 'h2' | 'h3';

const TagMap: Record<HeadingTag, React.ElementType> = { h1: 'h1', h2: 'h2', h3: 'h3' };

interface SectionHeadingProps {
  eyebrow?: string;
  title: string | React.ReactNode;
  description?: string;
  titleTag?: HeadingTag;
  className?: string;
  actions?: React.ReactNode;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  titleTag = 'h2',
  className = '',
  actions,
}: SectionHeadingProps) {
  const Tag = TagMap[titleTag];
  return (
    <div className={`section-heading ${className}`}>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <Tag>{title}</Tag>
      {description && <p>{description}</p>}
      {actions && <div className="cc-flex-1 cc-text-right">{actions}</div>}
    </div>
  );
}
