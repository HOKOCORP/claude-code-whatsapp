# Privacy Policy — {{SERVICE_NAME}}

> **TEMPLATE NOTICE.** This document is a starting point provided with the
> open-source `claude-code-whatsapp` project. It is **not** legal advice.
> A qualified lawyer in your jurisdiction must review and adapt it
> before publication. Replace every `{{PLACEHOLDER}}` and remove this
> notice.

**Effective date:** {{EFFECTIVE_DATE}}
**Last updated:** {{LAST_UPDATED_DATE}}

This Privacy Policy explains how {{OPERATOR_LEGAL_NAME}} ("we", "us",
"our") collects, uses, and shares personal data when you use
{{SERVICE_NAME}} (the "Service"). We are the data controller for the
purposes of UK / EU GDPR.

If you have questions, contact us at {{OPERATOR_CONTACT_EMAIL}} or our
data protection contact at {{DPO_OR_CONTACT_EMAIL}}.

## 1. What we collect

| Category | What | Source |
|---|---|---|
| **Identifier** | Your WhatsApp phone number, push name (the display name you've set in WhatsApp) | You |
| **Conversation content** | Messages you send to the bot, the bot's replies, attachments you upload | You |
| **Usage telemetry** | Tokens consumed per request, model used, timestamps, balance changes | Generated automatically |
| **Payment metadata** | Stripe Checkout session ID, amount, success/failure, last-4 of card (where Stripe shares it) | Stripe |
| **Operational logs** | Errors, rate-limit events, abuse signals | Generated automatically |
| **API key (BYOK only)** | If you set your own Anthropic key via `/cckey`, we store it encrypted at rest using AES-256-GCM | You |

We do **not** collect:

- Your full payment card number, CVC, or expiry — these go directly to
  Stripe and never touch our infrastructure.
- Information about other parties' messages (in groups, only messages
  that explicitly invoke the bot are processed; passive group chatter
  is ignored at the bot layer).

## 2. How we use it

- **To provide the Service.** Send your messages to Anthropic for
  inference; return replies; track your balance and usage.
- **For billing.** Process payments via Stripe; deduct usage from your
  balance; retain records for tax and audit.
- **For fraud and abuse prevention.** Detect runaway sessions,
  suspicious payment patterns, and ToS violations.
- **For service improvement.** Aggregated, anonymised usage analytics
  to improve performance and reliability. We do not train models on
  your conversations.
- **For legal compliance.** Respond to lawful requests; comply with
  AML and tax obligations.

## 3. Legal basis (UK/EU GDPR Article 6)

- **Performance of a contract** (Art 6(1)(b)) — for the core Service
  and billing.
- **Legitimate interests** (Art 6(1)(f)) — for fraud prevention,
  security, and aggregate analytics. You can object; see Section 8.
- **Legal obligation** (Art 6(1)(c)) — for tax records and lawful
  requests.
- **Consent** (Art 6(1)(a)) — for any optional features that
  explicitly ask for it.

## 4. Sharing with third parties

We share personal data with the following processors as necessary to
provide the Service. Each is bound by their own data-protection terms.

- **Anthropic, PBC** — receives conversation content and prompts to
  generate replies. Anthropic's
  [privacy policy](https://www.anthropic.com/legal/privacy) governs
  their use; we do not authorise them to use your content for
  model training.
- **Stripe, Inc.** — processes card payments. Sees your card data
  directly. Their
  [privacy notice](https://stripe.com/privacy) governs their use.
- **WhatsApp / Meta Platforms, Inc.** — operates the messaging
  channel. Sees your messages in transit. Their
  [privacy notice](https://www.whatsapp.com/legal/privacy-policy)
  governs their use.
- **Hosting providers.** Our servers run on {{HOSTING_PROVIDER}} in
  {{HOSTING_REGION}}.

We do **not** sell your personal data, ever.

## 5. International transfers

Some processors (e.g. Anthropic, Stripe) are based in the United
States. Where personal data is transferred outside the UK / EEA, we
rely on the UK International Data Transfer Agreement, EU Standard
Contractual Clauses, or another approved mechanism for the relevant
processor.

## 6. Retention

| Category | Retention |
|---|---|
| Conversation content (per-user `.jsonl` history) | Until you `/clear` it, you stop using the Service for {{INACTIVITY_PERIOD}}, or you request deletion. |
| Usage telemetry | {{USAGE_RETENTION}}. |
| Payment records | {{PAYMENT_RETENTION}} — typically 6 years for tax and audit purposes. |
| Operational logs | {{LOGS_RETENTION}}. |
| Encrypted BYOK key | Until you `/cckey remove` or until your account is deleted. |

After the retention period, data is deleted or irreversibly anonymised.

## 7. Security

- All API keys (BYOK) are stored encrypted at rest using AES-256-GCM
  with a key derived via scrypt from a master secret held outside the
  database.
- Access to user data is restricted to the operator on the host
  server.
- Per-user isolation: each user's session runs as a separate Linux
  user with its own home directory and filesystem permissions.
- Card data never reaches our servers; Stripe handles all PCI scope.
- TLS in transit between the user's WhatsApp client, WhatsApp's
  servers, and our infrastructure.

No system is perfectly secure. If we become aware of a breach
affecting your data, we will notify you and (where required) the
Information Commissioner's Office within 72 hours.

## 8. Your rights (UK/EU GDPR)

You have the right to:

- **Access** the personal data we hold about you.
- **Rectify** inaccurate data.
- **Erase** your data ("right to be forgotten") — subject to legal
  retention obligations (e.g. payment records).
- **Restrict processing** while a request is being investigated.
- **Object** to processing based on legitimate interests.
- **Data portability** — receive a machine-readable copy of your data.
- **Withdraw consent** for any processing based on consent.
- **Lodge a complaint** with your data-protection authority (UK: the
  [ICO](https://ico.org.uk)).

Exercise any of these by emailing {{DPO_OR_CONTACT_EMAIL}}. We aim to
respond within 30 days. We may need to verify your identity (e.g. by
asking you to send a confirmation message from your WhatsApp account)
before disclosing personal data.

## 9. Children

The Service is not directed to anyone under 18. If you become aware
that a child has provided personal data to the Service, please contact
us so we can delete it.

## 10. Cookies & web analytics

The Service operates over WhatsApp; we don't operate consumer-facing
web pages. Any pages we host (e.g. these legal pages) use only
strictly necessary cookies and have no analytics or third-party
trackers, unless explicitly noted.

## 11. Changes to this policy

We may update this Privacy Policy. Material changes will be announced
via WhatsApp and reflected in the "Last updated" date above. If we
expand the categories of data collected or the purposes for processing
in a way that materially affects you, we will obtain consent before
the change takes effect.

## 12. Contact

- **General privacy questions:** {{DPO_OR_CONTACT_EMAIL}}
- **Subject access requests:** {{DPO_OR_CONTACT_EMAIL}} (please put
  "SAR" in the subject line)
- **Operator legal entity:** {{OPERATOR_LEGAL_NAME}}, {{OPERATOR_REGISTERED_ADDRESS}}, {{OPERATOR_COMPANY_NUMBER}}
- **Data Protection Authority (UK):**
  [Information Commissioner's Office](https://ico.org.uk)
