import { ArrowRight, BookUser, CheckCircle2, ClipboardCheck, GraduationCap, Users, UserSquare2 } from 'lucide-react';

const workflowSteps = [
  { title: 'Applications', detail: 'Capture new student admission applications, preferred programme, and intake period.' },
  { title: 'Applicant information', detail: 'Collect student details, guardians, documents, and any special support requirements.' },
  { title: 'Status tracking', detail: 'Monitor each stage from submitted, under review, accepted, and registered to enrolled.' },
  { title: 'Decisions', detail: 'Approve, decline, or defer applications with clear notes and follow-up actions.' },
  { title: 'Registration', detail: 'Complete registration details and create a formal student record in the school system.' },
  { title: 'Class placement', detail: 'Assign the new learner to the right class and academic pathway based on assessment and age.' },
  { title: 'Admission history', detail: 'Keep a complete record of prior application outcomes, placements, and academic movement.' },
];

const keyFeatures = [
  'Student admission applications',
  'Applicant information and documents',
  'Application status tracking',
  'Admission decisions',
  'Student registration',
  'Class placement',
  'Admission history',
];

const statusSummary = [
  { label: 'Submitted', count: '24', tone: '#f59e0b' },
  { label: 'Under review', count: '16', tone: '#3b82f6' },
  { label: 'Accepted', count: '9', tone: '#10b981' },
  { label: 'Registered', count: '6', tone: '#8b5cf6' },
];

export function AdmissionsPage() {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">School administration</span>
          <h1>Admissions &amp; enrolment</h1>
          <p>Manage the student intake journey from first enquiry to successful registration and class placement.</p>
        </div>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        {statusSummary.map((item) => (
          <div key={item.label} className="content-card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.7 }}>{item.label}</span>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: item.tone, display: 'inline-block' }} />
            </div>
            <strong style={{ fontSize: 28, display: 'block' }}>{item.count}</strong>
          </div>
        ))}
      </section>

      <section className="content-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div>
            <span className="eyebrow">Core workflow</span>
            <h2 style={{ margin: '8px 0 0' }}>Admissions lifecycle</h2>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#0f766e', background: '#d1fae5', padding: '8px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
            <CheckCircle2 size={14} /> Parent applications can be started from the public school website when enabled in settings
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {workflowSteps.map((step, index) => (
            <div key={step.title} style={{ border: '1px solid #e5e7eb', borderRadius: 16, padding: 16, background: '#f9fafb' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, background: '#dbeafe', color: '#1d4ed8', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>{index + 1}</span>
                <ArrowRight size={16} color="#6b7280" />
              </div>
              <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>{step.title}</h3>
              <p style={{ margin: 0, color: '#4b5563', lineHeight: 1.6 }}>{step.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 20 }}>
        <article className="content-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <Users size={18} color="#2563eb" />
            <h2 style={{ margin: 0 }}>Must-have functionality</h2>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
            {keyFeatures.map((feature) => (
              <li key={feature} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: '#f3f4f6' }}>
                <CheckCircle2 size={16} color="#16a34a" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="content-card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <BookUser size={18} color="#7c3aed" />
            <h2 style={{ margin: 0 }}>Public intake</h2>
          </div>
          <p style={{ margin: '0 0 12px', color: '#4b5563', lineHeight: 1.7 }}>
            Families can complete a secure application directly from the school’s public website when the school enables the setting in the website configuration.
          </p>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><ClipboardCheck size={16} color="#0ea5e9" /><span>Application form with required documents</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><UserSquare2 size={16} color="#ef4444" /><span>Student and guardian profile capture</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><GraduationCap size={16} color="#8b5cf6" /><span>Decision flow into registration and class placement</span></div>
          </div>
        </article>
      </section>
    </div>
  );
}
