// Sends order-status notification emails to customers via Gmail SMTP.
//
// Requires two env vars (see .env):
//   EMAIL_USER          - the Gmail address to send from
//   EMAIL_APP_PASSWORD   - a Gmail "App Password" for that account (NOT the
//                          normal login password - Gmail requires 2-Step
//                          Verification to be enabled before it will issue one)
//
// If those env vars aren't set, sendOrderStatusEmail() silently no-ops
// (logged once) so the rest of the app keeps working without email configured.
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const isConfigured = Boolean(EMAIL_USER && EMAIL_APP_PASSWORD);

if (!isConfigured) {
  console.warn(
    "[mailer] EMAIL_USER / EMAIL_APP_PASSWORD not set - order status emails are disabled."
  );
}

const transporter = isConfigured
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    })
  : null;

const FROM = `"Book Ocean BD" <${EMAIL_USER}>`;
const SITE_URL = (process.env.CLIENT_URL || "https://bookoceanbd.com").replace(/\/+$/, "");
const BOOKS_URL = `${SITE_URL}/books`;

// embedded via cid so it renders inline without depending on external image
// hosting - see LOGO_ATTACHMENT below
const LOGO_PATH = path.join(__dirname, "assets", "logo.jpg");
const LOGO_CID = "bookoceanbd-logo";
const LOGO_ATTACHMENT = fs.existsSync(LOGO_PATH)
  ? [{ filename: "logo.jpg", path: LOGO_PATH, cid: LOGO_CID }]
  : [];
if (LOGO_ATTACHMENT.length === 0) {
  console.warn(`[mailer] logo not found at ${LOGO_PATH} - emails will send without it.`);
}

// small plain-text brand line at the top - the actual logo image goes in the
// footer instead (per request: logo at the end, not the top)
const TOP_BRAND_HTML = `<p style="text-align:center; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color:#94a3b8; margin: 0 0 16px;">Book Ocean BD</p>`;

const LOGO_FOOTER_HTML = LOGO_ATTACHMENT.length
  ? `<div style="text-align:center; margin-top: 18px;"><img src="cid:${LOGO_CID}" alt="Book Ocean BD" width="64" style="display:inline-block;" /></div>`
  : "";

const SUPPORT_FOOTER_HTML = `
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
  <p style="font-size: 13px; color:#64748b; line-height: 1.6;">
    Need help? We're here for you.<br/>
    📞 <a href="tel:+8801568175528" style="color:#1e293b; text-decoration:none;">+88 01568175528</a><br/>
    ✉️ <a href="mailto:info@bookoceanbd.com" style="color:#1e293b; text-decoration:none;">info@bookoceanbd.com</a><br/>
    💬 <a href="https://m.me/bookoceanbd" style="color:#1e293b; text-decoration:none;">m.me/bookoceanbd</a><br/>
    📘 <a href="https://www.facebook.com/bookoceanbd/" style="color:#1e293b; text-decoration:none;">facebook.com/bookoceanbd</a><br/>
    📷 <a href="https://www.instagram.com/bookoceanbd/" style="color:#1e293b; text-decoration:none;">instagram.com/bookoceanbd</a>
  </p>
  ${LOGO_FOOTER_HTML}
  <p style="font-size: 12px; color: #94a3b8; margin-top: 12px; text-align:center;">Book Ocean BD &middot; bookoceanbd.com</p>
`;

// wraps any email body with the shared top brand line + footer (logo,
// contact info, social links)
function buildLayout(innerHtml) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1e293b;">
      ${TOP_BRAND_HTML}
      ${innerHtml}
      ${SUPPORT_FOOTER_HTML}
    </div>
  `;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// "Inside Dhaka" vs "Outside Dhaka" is chosen at checkout (see Checkout.jsx,
// order.data.area is 'dhaka' | 'outside') - fall back to mentioning both if
// it's missing on an older order.
function deliveryEstimateHtml(order) {
  const area = order.data?.area;
  if (area === "dhaka") {
    return "You're inside Dhaka, so expect delivery within <strong>72 hours</strong>.";
  }
  if (area === "outside") {
    return "You're outside Dhaka, so expect delivery within <strong>3-4 days</strong>.";
  }
  return "Delivery usually takes up to <strong>72 hours inside Dhaka</strong>, or <strong>3-4 days outside Dhaka</strong>.";
}

// A full Mongo ObjectId (24 hex chars) is not something a customer wants to
// read in an email - derive a short 4-digit numeric reference instead.
// Not guaranteed globally unique (1-in-10000 chance of collision between any
// two orders), but it's just a display reference; support can always look an
// order up by email/date, and the admin dashboard has the real _id.
function shortInvoiceId(order) {
  const hex = order._id?.toString();
  if (!hex) return "----";
  const num = BigInt("0x" + hex) % 10000n;
  return num.toString().padStart(4, "0");
}

// order.date is stored as 'yyyy-MM-dd HH:mm:ss' (see Checkout.jsx) - split
// into separate date/time for display rather than one blob string.
function orderMetaTableHtml(order, { includeAmount = false } = {}) {
  const [datePart, timePart] = (order.date || "").split(" ");
  const amountRow = includeAmount
    ? `<tr><td>Amount</td><td style="text-align:right; font-weight:bold; color:#1e293b;">৳${order.totalAmount ?? ""}</td></tr>`
    : "";
  return `
    <table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; color:#64748b;">
      <tr><td>Invoice ID</td><td style="text-align:right;">#${shortInvoiceId(order)}</td></tr>
      <tr><td>Order Date</td><td style="text-align:right;">${escapeHtml(datePart)}</td></tr>
      <tr><td>Order Time</td><td style="text-align:right;">${escapeHtml(timePart)}</td></tr>
      ${amountRow}
    </table>
  `;
}

function invoiceTableHtml(order) {
  const rows = (order.cart || [])
    .map((book) => {
      const price = book.discountPrice ?? book.price ?? 0;
      const qty = book.quantity ?? 1;
      return `
        <tr>
          <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
            ${escapeHtml(book.name)}${book.author ? `<br/><span style="color:#64748b; font-size: 12px;">by ${escapeHtml(book.author)}</span>` : ""}
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; text-align:center;">${qty}</td>
          <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; text-align:right;">৳${price}</td>
        </tr>`;
    })
    .join("");

  return `
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
      <thead>
        <tr>
          <th style="text-align:left; padding-bottom: 6px; border-bottom: 2px solid #1e293b;">Book</th>
          <th style="text-align:center; padding-bottom: 6px; border-bottom: 2px solid #1e293b;">Qty</th>
          <th style="text-align:right; padding-bottom: 6px; border-bottom: 2px solid #1e293b;">Price</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="2" style="padding-top: 10px; color:#64748b;">Subtotal</td><td style="padding-top: 10px; text-align:right;">৳${order.total ?? ""}</td></tr>
        <tr><td colspan="2" style="color:#64748b;">Delivery charge</td><td style="text-align:right;">৳${order.deliveryCharge ?? ""}</td></tr>
        <tr><td colspan="2" style="padding-top: 6px; font-weight:bold;">Total</td><td style="padding-top: 6px; text-align:right; font-weight:bold;">৳${order.totalAmount ?? ""}</td></tr>
      </tfoot>
    </table>
  `;
}

function simpleItemListHtml(order) {
  const items = (order.cart || [])
    .map((book) => {
      const price = book.discountPrice ?? book.price ?? "";
      return `<li>${escapeHtml(book.name)}${book.author ? ` — by ${escapeHtml(book.author)}` : ""} (৳${price})</li>`;
    })
    .join("");
  return `<ul style="font-size: 14px; padding-left: 20px;">${items}</ul>`;
}

function buildOrderStatusHtml(order, status) {
  const name = escapeHtml(order.data?.name) || "there";

  if (status === "approve") {
    return buildLayout(`
      <p>Hi ${name},</p>
      <p style="font-size: 16px; font-weight: bold;">Your order has been confirmed!</p>
      <p>Here's your invoice. We're getting your books ready now.</p>
      ${orderMetaTableHtml(order)}
      ${invoiceTableHtml(order)}
      <p style="font-size: 14px; background:#f1f5f9; padding: 12px; border-radius: 6px;">🚚 ${deliveryEstimateHtml(order)}</p>
    `);
  }

  // canceled
  return buildLayout(`
    <p>Hi ${name},</p>
    <p style="font-size: 16px; font-weight: bold;">We're sorry - your order has been canceled</p>
    <p>Unfortunately, one or more books in your order are currently out of stock, so we weren't able to fulfill it this time. We're sorry for the inconvenience.</p>
    ${orderMetaTableHtml(order, { includeAmount: true })}
    <p style="color:#64748b; font-size: 13px;">Items from your order:</p>
    ${simpleItemListHtml(order)}
    <p style="text-align: center; margin: 24px 0;">
      <a href="${BOOKS_URL}" style="background:#1e293b; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:6px; font-weight:bold; display:inline-block;">Browse Other Books</a>
    </p>
  `);
}

// no 'delivered' entry - no email is sent for that status (see index.js
// /orders/delivery-order/:id)
const SUBJECTS = {
  approve: "Your Book Ocean BD order is confirmed - invoice inside",
  canceled: "Your Book Ocean BD order has been canceled",
};

function buildPasswordResetHtml(resetLink) {
  return buildLayout(`
    <p style="font-size: 16px; font-weight: bold; text-align:center;">Reset your password</p>
    <p>We received a request to reset the password for your Book Ocean BD account. Click the button below to choose a new one.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${resetLink}" style="background:#1e293b; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:6px; font-weight:bold; display:inline-block;">Reset Password</a>
    </p>
    <p style="font-size: 13px; color:#64748b;">This link will expire soon for your security. If you didn't request this, you can safely ignore this email - your password won't be changed.</p>
  `);
}

function buildVerificationHtml(verifyLink) {
  return buildLayout(`
    <p style="font-size: 16px; font-weight: bold; text-align:center;">Verify your email</p>
    <p>Thanks for creating a Book Ocean BD account! Please confirm this is really your email address by clicking the button below.</p>
    <p style="text-align: center; margin: 28px 0;">
      <a href="${verifyLink}" style="background:#1e293b; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:6px; font-weight:bold; display:inline-block;">Verify Email Address</a>
    </p>
    <p style="font-size: 13px; color:#64748b;">If you didn't create this account, you can safely ignore this email.</p>
  `);
}

// order: the order document (must have .email, .data.name, .cart, .date,
// .total, .deliveryCharge, .totalAmount, .data.area)
// status: 'approve' | 'canceled' (no email is sent for 'delivered')
async function sendOrderStatusEmail(order, status) {
  if (!isConfigured) return;
  if (!order?.email) {
    console.warn(`[mailer] order ${order?._id} has no customer email on file, skipping notification.`);
    return;
  }
  const subject = SUBJECTS[status];
  if (!subject) {
    console.warn(`[mailer] no email template for status "${status}", skipping.`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to: order.email,
    subject,
    html: buildOrderStatusHtml(order, status),
    attachments: LOGO_ATTACHMENT,
  });
}

// resetLink: a Firebase password-reset action link, generated server-side via
// firebaseAdminLite.generatePasswordResetLink() (see index.js /auth/forgot-password)
async function sendPasswordResetEmail(toEmail, resetLink) {
  if (!isConfigured) return;
  await transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "Reset your Book Ocean BD password",
    html: buildPasswordResetHtml(resetLink),
    attachments: LOGO_ATTACHMENT,
  });
}

// verifyLink: a Firebase email-verification action link, generated
// server-side via firebaseAdminLite.generateEmailVerificationLink()
// (see index.js /auth/send-verification-email)
async function sendVerificationEmail(toEmail, verifyLink) {
  if (!isConfigured) return;
  await transporter.sendMail({
    from: FROM,
    to: toEmail,
    subject: "Verify your email for Book Ocean BD",
    html: buildVerificationHtml(verifyLink),
    attachments: LOGO_ATTACHMENT,
  });
}

module.exports = { sendOrderStatusEmail, sendPasswordResetEmail, sendVerificationEmail };
