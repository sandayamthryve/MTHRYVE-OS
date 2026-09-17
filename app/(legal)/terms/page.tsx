import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service · Mthryve OS",
  description:
    "The terms governing authorized use of Mthryve OS, the internal operating system of Mthryve Marketing Inc.",
};

export default function TermsPage() {
  return (
    <>
      <p className="legal-eyebrow">Legal</p>
      <h1>Terms of Service</h1>
      <p className="legal-effective">Effective date: July 12, 2026 · Last updated: July 12, 2026</p>

      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of Mthryve OS
        (the &ldquo;Platform&rdquo;), the internal operating system provided by Mthryve Marketing
        Inc. (&ldquo;Mthryve,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By
        accessing or using the Platform, you (&ldquo;User&rdquo; or &ldquo;you&rdquo;) agree to
        these Terms. If you do not agree, do not access or use the Platform.
      </p>

      <h2>1. Eligibility and Access</h2>
      <p>
        The Platform is provided for authorized business use only. Access is granted by invitation
        and provisioned by an administrator. You may use the Platform solely for legitimate Mthryve
        business purposes and only within the scope of the role and permissions assigned to your
        account. Access is not transferable.
      </p>

      <h2>2. Accounts and Security</h2>
      <p>
        You are responsible for maintaining the confidentiality of your credentials and for all
        activity that occurs under your account. You agree to use a strong, unique password, to
        keep your login details secure, and to notify us promptly of any unauthorized access or
        suspected security incident. We may suspend or revoke access at any time to protect the
        Platform or the business.
      </p>

      <h2>3. Acceptable Use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Platform for any unlawful, fraudulent, or unauthorized purpose;</li>
        <li>Access data or areas of the Platform beyond your assigned permissions;</li>
        <li>
          Interfere with or disrupt the integrity, security, or performance of the Platform;
        </li>
        <li>
          Attempt to probe, scan, reverse engineer, or circumvent authentication or access
          controls;
        </li>
        <li>
          Copy, export, or disclose company or Platform data except as required for your work and
          permitted by company policy; or
        </li>
        <li>Introduce malware or any code intended to harm or gain unauthorized access.</li>
      </ul>

      <h2>4. Company Data and Confidentiality</h2>
      <p>
        All content, records, and data within the Platform are the confidential property of
        Mthryve or its licensors and business partners. You must treat this information as
        confidential, use it only for authorized purposes, and handle it in accordance with
        applicable company policies and law. Your obligations of confidentiality survive the
        termination of your access.
      </p>

      <h2>5. Intellectual Property</h2>
      <p>
        The Platform, including its software, design, and content (excluding your operational work
        product), is owned by Mthryve or its licensors and is protected by intellectual property
        laws. These Terms do not grant you any ownership rights in the Platform. You may not
        reproduce, distribute, or create derivative works from the Platform except as expressly
        authorized.
      </p>

      <h2>6. Availability and Changes</h2>
      <p>
        We may modify, suspend, or discontinue any part of the Platform at any time, with or
        without notice. We may also update, add, or remove features. We are not liable for any
        interruption of availability or for changes to the Platform.
      </p>

      <h2>7. Disclaimers</h2>
      <p>
        The Platform is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis,
        without warranties of any kind, whether express or implied, including warranties of
        merchantability, fitness for a particular purpose, and non-infringement, to the fullest
        extent permitted by law.
      </p>

      <h2>8. Limitation of Liability</h2>
      <p>
        To the fullest extent permitted by law, Mthryve will not be liable for any indirect,
        incidental, special, consequential, or punitive damages, or for any loss of data, profits,
        or business, arising out of or related to your use of or inability to use the Platform.
      </p>

      <h2>9. Termination</h2>
      <p>
        Your access to the Platform ends automatically when your relationship with Mthryve ends or
        when your account is deactivated. We may suspend or terminate access at any time for any
        reason, including violation of these Terms. Provisions that by their nature should survive
        termination will survive.
      </p>

      <h2>10. Changes to These Terms</h2>
      <p>
        We may revise these Terms from time to time. When we do, we will update the &ldquo;Last
        updated&rdquo; date above and, where appropriate, provide notice through the Platform. Your
        continued use of the Platform after an update constitutes acceptance of the revised Terms.
      </p>

      <h2>11. Contact Us</h2>
      <p>
        Questions about these Terms may be directed to Mthryve Marketing Inc. at{" "}
        <a href="mailto:mthryve.digital@gmail.com">mthryve.digital@gmail.com</a>.
      </p>
    </>
  );
}
