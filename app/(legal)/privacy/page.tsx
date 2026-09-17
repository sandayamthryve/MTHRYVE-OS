import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy · Mthryve OS",
  description:
    "How Mthryve Marketing Inc. collects, uses, and protects information within Mthryve OS.",
};

export default function PrivacyPage() {
  return (
    <>
      <p className="legal-eyebrow">Legal</p>
      <h1>Privacy Policy</h1>
      <p className="legal-effective">Effective date: July 12, 2026 · Last updated: July 12, 2026</p>

      <p>
        This Privacy Policy explains how Mthryve Marketing Inc. (&ldquo;Mthryve,&rdquo;
        &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, and
        safeguards information in connection with Mthryve OS (the &ldquo;Platform&rdquo;), our
        internal, invite-only operating system used to run the company&rsquo;s day-to-day work.
        The Platform is provided to authorized personnel, contractors, and partners
        (&ldquo;Users&rdquo;) for business purposes only.
      </p>

      <h2>1. Information We Collect</h2>
      <p>We collect the following categories of information:</p>
      <ul>
        <li>
          <strong>Account information.</strong> Name, work email address, role, department,
          and profile details created when your account is provisioned by an administrator.
        </li>
        <li>
          <strong>Operational content.</strong> Data you enter or generate while using the
          Platform, such as tasks, projects, approvals, reports, messages, attendance records,
          and other work product.
        </li>
        <li>
          <strong>Usage and device data.</strong> Log data such as pages viewed, actions taken,
          timestamps, IP address, and browser or device type, collected automatically to keep
          the Platform secure and reliable.
        </li>
        <li>
          <strong>Authentication data.</strong> Session tokens and credentials used to sign you
          in and keep your session active.
        </li>
      </ul>

      <h2>2. How We Use Information</h2>
      <p>We use information to:</p>
      <ul>
        <li>Operate, maintain, and secure the Platform;</li>
        <li>Provide access controls appropriate to your role and department;</li>
        <li>Enable the core workflows of the business, including tasks, approvals, and reporting;</li>
        <li>Monitor for, investigate, and prevent security incidents, fraud, and misuse;</li>
        <li>Improve the Platform&rsquo;s functionality, performance, and usability; and</li>
        <li>Comply with our legal and regulatory obligations.</li>
      </ul>

      <h2>3. How Information Is Shared</h2>
      <p>
        Mthryve OS is an internal tool. We do not sell your information. We share information
        only as necessary to run the business, including:
      </p>
      <ul>
        <li>
          <strong>Within the company.</strong> With other authorized Users on a need-to-know
          basis, consistent with your role and the Platform&rsquo;s access controls.
        </li>
        <li>
          <strong>Service providers.</strong> With vendors that host, secure, or support the
          Platform, bound by confidentiality and data-protection obligations.
        </li>
        <li>
          <strong>Legal and safety.</strong> When required by law, or to protect the rights,
          property, or safety of Mthryve, our Users, or others.
        </li>
      </ul>

      <h2>4. Data Retention</h2>
      <p>
        We retain information for as long as your account is active and as needed to provide the
        Platform, and thereafter as required to meet legal, accounting, or business-record
        obligations. When information is no longer needed, we take reasonable steps to delete or
        de-identify it.
      </p>

      <h2>5. Security</h2>
      <p>
        We use administrative, technical, and organizational safeguards designed to protect
        information, including role-based access controls, authenticated sessions, and encryption
        in transit. No system is perfectly secure, and we cannot guarantee absolute security, but
        we work to protect information consistent with its sensitivity.
      </p>

      <h2>6. Your Choices and Rights</h2>
      <p>
        Because the Platform is an employer- and business-administered system, most information is
        managed by administrators. Depending on your location and applicable law, you may have
        rights to access, correct, or request deletion of certain personal information. To make a
        request, contact us using the details below. We will respond consistent with applicable
        law.
      </p>

      <h2>7. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we do, we will revise the
        &ldquo;Last updated&rdquo; date above. Material changes will be communicated through the
        Platform or by other appropriate means. Your continued use of the Platform after an update
        indicates your acknowledgment of the revised policy.
      </p>

      <h2>8. Contact Us</h2>
      <p>
        If you have questions about this Privacy Policy or how your information is handled, contact
        Mthryve Marketing Inc. at{" "}
        <a href="mailto:mthryve.digital@gmail.com">mthryve.digital@gmail.com</a>.
      </p>
    </>
  );
}
