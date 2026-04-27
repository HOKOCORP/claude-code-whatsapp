# Legal templates

Boilerplate Terms of Service and Privacy Policy for an operator running
HOKO Coder (or any fork of `claude-code-whatsapp`) as a paid bot.

> **THESE ARE TEMPLATES, NOT LEGAL ADVICE.** They are a starting point.
> A qualified lawyer in your jurisdiction must review and adapt them
> before you publish or charge users. The author of this repository is
> not a lawyer; nothing here constitutes legal advice. Consider these
> documents incomplete until a lawyer signs off.

## What's here

- [`tos.md`](tos.md) — Terms of Service (includes pricing, refunds,
  BYOK, acceptable use, IP, liability, governing law).
- [`privacy.md`](privacy.md) — Privacy Policy (data we collect, third
  parties we share with, GDPR rights, retention, security).

Both files contain `{{PLACEHOLDERS}}` you fill in for your operator
identity (legal entity, contact, jurisdiction, effective date, etc.).

## How to deploy

1. **Replace the placeholders.** Search for `{{` to find them.
2. **Get a lawyer to review.** Especially the liability, indemnification,
   refund, and governing-law sections. Different jurisdictions have
   different consumer-protection rules you can't waive.
3. **Convert to HTML or your CMS format.** A quick `pandoc tos.md -o
   tos.html --metadata title="Terms of Service"` works. Or paste into
   any static-site generator.
4. **Host them.** Anywhere accessible — your existing nginx, a
   Cloudflare Pages project, GitHub Pages, etc.
5. **Wire the bot.** Set the two env vars (e.g. via `ccm` Settings →
   Credentials, since they're now in the SIMPLE_CREDS list):

   ```
   BOT_TOS_URL=https://your-domain/tos
   BOT_PRIVACY_URL=https://your-domain/privacy
   ```

   The bot's `/about` command and the Stripe Checkout return path
   surface these URLs to users.

6. **Re-publish on changes.** When you update either document, change
   the "Last updated" line at the top, and consider notifying existing
   users via WhatsApp broadcast if changes are material.

## Specific things to check with your lawyer

- **Refund / cancellation.** The default text says "all sales final, no
  refunds whatsoever." UK and EU consumer law has statutory rights you
  *cannot* waive (e.g. distance-selling cooling-off periods for some
  digital goods). The exemption that usually applies — "digital content
  whose performance has begun with the consumer's express prior consent
  and acknowledgement that they thereby lose the right of withdrawal"
  (UK Consumer Contracts Regulations 2013 reg 37) — is the basis for
  the default text, but it requires the consumer to actively consent to
  the loss of withdrawal right. The Stripe Checkout flow doesn't
  currently do that; ask your lawyer whether the in-bot `/about` plus
  the post-payment confirmation suffice.
- **AML / KYC.** UK Money Laundering Regulations apply if you're
  handling top-ups above certain thresholds. Stripe's risk team handles
  much of this for you, but you may need a written policy.
- **Data controller status.** If you operate in the UK / EU, you're a
  GDPR data controller. The `privacy.md` template assumes that. Confirm
  whether you need to register with your country's DPA (e.g. ICO in the
  UK; £40-£60 / year flat fee).
- **Anthropic ToS pass-through.** When users send chat content to your
  bot, Anthropic processes it. The privacy template lists Anthropic as
  a sub-processor; check whether a formal Data Processing Addendum
  (DPA) with Anthropic is required for your scale.
- **Stripe DPA.** Stripe makes their DPA available; sign it before you
  enable live charging.
- **Children / age.** WhatsApp's own ToS requires users be 13+ (or 16+
  in some EU countries). The template requires 18+ — adjust if you
  want to allow younger users, but that triggers different consent and
  data-handling rules.

## What NOT to do

- Do not ship these unmodified. The placeholders look like
  `{{OPERATOR_LEGAL_NAME}}` for a reason.
- Do not claim "lawyer-reviewed" until a lawyer has actually reviewed.
- Do not use these templates for jurisdictions outside the UK / EU /
  common-law systems without significant rewriting.
- Do not assume "no refund" is bulletproof. See the consumer-law note
  above.
