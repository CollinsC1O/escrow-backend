/**
 * Estimated withholding tax generator with overflow / digit-limit validation.
 *
 * Every parameter mismatch or calculation exception is reported through a
 * namespaced warning code so callers can programmatically distinguish between
 * different failure modes (e.g. invalid gross amount vs. bad tax rate vs.
 * intermediate overflow) without parsing human-readable error strings.
 *
 * Design principles
 * -----------------
 * • All arithmetic is performed with BigInt to prevent floating-point drift.
 * • Digit-count guards reject inputs that would cause unsafe numeric overflow
 *   before any multiplication takes place.
 * • Intermediate products (gross × rate) are checked against a wider digit
 *   budget (MAX_INTERMEDIATE_DIGITS) before being divided back to tax amounts.
 * • Every public function returns a tagged-union result – never throws – so
 *   callers can exhaustively pattern-match on { ok: true } / { ok: false }.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum decimal digits for a single amount or rate operand. */
export const MAX_SAFE_DIGITS = 15;

/** Maximum decimal digits for an intermediate multiplication product. */
export const MAX_INTERMEDIATE_DIGITS = MAX_SAFE_DIGITS * 2;

/**
 * Default tax rate scale denominator.
 * A rate of 1500 with DEFAULT_TAX_SCALE = 10_000 represents 15.00% (1500 bps).
 */
export const DEFAULT_TAX_SCALE = 10_000;

// ---------------------------------------------------------------------------
// Warning / error codes
// ---------------------------------------------------------------------------

/**
 * Namespaced warning codes emitted by the tax_deduction_estimator.
 *
 * TAX_ESTIMATOR_EXCESSIVE_DIGITS   – an operand has too many decimal digits
 * TAX_ESTIMATOR_INVALID_AMOUNT     – gross amount is not a valid non-negative integer
 * TAX_ESTIMATOR_INVALID_TAX_RATE   – tax rate is not a valid non-negative integer
 * TAX_ESTIMATOR_INVALID_SCALE      – rate scale is not a valid positive integer
 * TAX_ESTIMATOR_INVALID_BRACKET    – a tax bracket entry is structurally invalid
 * TAX_ESTIMATOR_RATE_EXCEEDS_SCALE – tax rate is larger than its scale (> 100%)
 * TAX_ESTIMATOR_OVERFLOW           – intermediate multiplication would overflow
 * TAX_ESTIMATOR_TAX_EXCEEDS_AMOUNT – estimated tax exceeds the gross amount
 * TAX_ESTIMATOR_EMPTY_BRACKETS     – bracket schedule is empty
 */
export const ERROR_CODES = {
  EXCESSIVE_DIGITS: "TAX_ESTIMATOR_EXCESSIVE_DIGITS",
  INVALID_AMOUNT: "TAX_ESTIMATOR_INVALID_AMOUNT",
  INVALID_TAX_RATE: "TAX_ESTIMATOR_INVALID_TAX_RATE",
  INVALID_SCALE: "TAX_ESTIMATOR_INVALID_SCALE",
  INVALID_BRACKET: "TAX_ESTIMATOR_INVALID_BRACKET",
  RATE_EXCEEDS_SCALE: "TAX_ESTIMATOR_RATE_EXCEEDS_SCALE",
  OVERFLOW: "TAX_ESTIMATOR_OVERFLOW",
  TAX_EXCEEDS_AMOUNT: "TAX_ESTIMATOR_TAX_EXCEEDS_AMOUNT",
  EMPTY_BRACKETS: "TAX_ESTIMATOR_EMPTY_BRACKETS",
} as const;

export type TaxEstimatorErrorCode =
  (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Result / outcome types
// ---------------------------------------------------------------------------

/** Generic single-value result used by individual validators. */
export type ValidationResult =
  | { ok: true; value: bigint }
  | { ok: false; error: string; code: TaxEstimatorErrorCode };

/**
 * Outcome of a flat-rate withholding tax estimation.
 *
 * On success:
 *   grossAmount  – validated gross amount as BigInt
 *   taxAmount    – estimated tax withheld (floor of gross x rate / scale)
 *   netAmount    – grossAmount - taxAmount
 *   remainder    – fractional dust from the integer division (gross x rate % scale)
 *   taxRateBps   – the effective rate expressed in basis points (rate / scale x 10000)
 */
export type TaxDeductionOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      taxAmount: bigint;
      netAmount: bigint;
      remainder: bigint;
      taxRateBps: bigint;
    }
  | { ok: false; error: string; code: TaxEstimatorErrorCode };

/**
 * A single bracket in a progressive/tiered tax schedule.
 *
 * upTo     – upper bound of this bracket (inclusive), expressed in the same
 *             integer unit as the gross amount; use null / undefined to mark
 *             the top-most (unlimited) bracket.
 * rate     – integer tax rate for amounts that fall within this bracket.
 * scale    – denominator for the rate (defaults to DEFAULT_TAX_SCALE).
 *
 * Example:  { upTo: 50_000, rate: 1000, scale: 10_000 } -> 10% up to 50,000
 *           { upTo: null,   rate: 2000, scale: 10_000 } -> 20% above 50,000
 */
export interface TaxBracket {
  upTo: string | number | bigint | null | undefined;
  rate: string | number | bigint;
  scale?: string | number | bigint;
}

/**
 * Outcome of a bracket-based (progressive) tax estimation.
 *
 * On success:
 *   grossAmount      – validated gross amount as BigInt
 *   bracketTaxes     – array of tax amounts, one per bracket (in order)
 *   totalTaxAmount   – sum of all bracketTaxes
 *   netAmount        – grossAmount - totalTaxAmount
 *   effectiveRateBps – effective rate = totalTaxAmount x 10_000n / grossAmount
 */
export type BracketTaxOutcome =
  | {
      ok: true;
      grossAmount: bigint;
      bracketTaxes: bigint[];
      totalTaxAmount: bigint;
      netAmount: bigint;
      effectiveRateBps: bigint;
    }
  | { ok: false; error: string; code: TaxEstimatorErrorCode };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count significant decimal digits, ignoring leading zeros and sign. */
function digitCount(normalized: string): number {
  const digits = normalized.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * Parse an integer from string | number | bigint and validate it against
 * the MAX_SAFE_DIGITS cap.  Returns a namespaced ValidationResult so the
 * calling validator can attach its own code on non-integer format errors.
 */
function parseIntegerInput(
  input: string | number | bigint,
  label: string,
  invalidCode: TaxEstimatorErrorCode
): ValidationResult {
  let raw: string;

  if (typeof input === "bigint") {
    raw = input.toString();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return {
        ok: false,
        error: `${label} must be a finite integer`,
        code: invalidCode,
      };
    }
    raw = String(input);
  } else {
    raw = input.trim();
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: `${label} must be an integer numeric value`,
        code: invalidCode,
      };
    }
  }

  if (digitCount(raw) > MAX_SAFE_DIGITS) {
    return {
      ok: false,
      error: `${label} exceeds maximum of ${MAX_SAFE_DIGITS} digits`,
      code: ERROR_CODES.EXCESSIVE_DIGITS,
    };
  }

  return { ok: true, value: BigInt(raw) };
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate a gross (pre-tax) amount.
 *
 * Emits TAX_ESTIMATOR_INVALID_AMOUNT when the value is not a non-negative
 * integer, and TAX_ESTIMATOR_EXCESSIVE_DIGITS when the digit count exceeds
 * MAX_SAFE_DIGITS.
 */
export function validateGrossAmount(
  input: string | number | bigint,
  label = "grossAmount"
): ValidationResult {
  const result = parseIntegerInput(input, label, ERROR_CODES.INVALID_AMOUNT);
  if (!result.ok) {
    return result;
  }
  if (result.value < 0n) {
    return {
      ok: false,
      error: `${label} must be a non-negative integer`,
      code: ERROR_CODES.INVALID_AMOUNT,
    };
  }
  return result;
}

/**
 * Validate an integer tax rate operand.
 *
 * Emits TAX_ESTIMATOR_INVALID_TAX_RATE when the value is not a non-negative
 * integer, and TAX_ESTIMATOR_EXCESSIVE_DIGITS when it is too large.
 */
export function validateTaxRate(
  input: string | number | bigint,
  label = "taxRate"
): ValidationResult {
  const result = parseIntegerInput(input, label, ERROR_CODES.INVALID_TAX_RATE);
  if (!result.ok) {
    return result;
  }
  if (result.value < 0n) {
    return {
      ok: false,
      error: `${label} must be a non-negative integer`,
      code: ERROR_CODES.INVALID_TAX_RATE,
    };
  }
  return result;
}

/**
 * Validate a rate scale (denominator).
 *
 * Emits TAX_ESTIMATOR_INVALID_SCALE when the value is not a positive integer,
 * and TAX_ESTIMATOR_EXCESSIVE_DIGITS when it exceeds the digit cap.
 */
export function validateTaxScale(
  input: string | number | bigint,
  label = "taxScale"
): ValidationResult {
  const result = parseIntegerInput(input, label, ERROR_CODES.INVALID_SCALE);
  if (!result.ok) {
    return result;
  }
  if (result.value <= 0n) {
    return {
      ok: false,
      error: `${label} must be a positive integer`,
      code: ERROR_CODES.INVALID_SCALE,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Flat-rate withholding tax estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the withholding tax on a gross amount using a single flat rate.
 *
 * Tax is calculated as:
 *   taxAmount = floor( grossAmount x taxRate / taxScale )
 *   netAmount = grossAmount - taxAmount
 *   remainder = (grossAmount x taxRate) % taxScale
 *
 * Parameters
 * ----------
 * grossAmount  – integer gross (pre-tax) amount in smallest token units.
 * taxRate      – integer rate (e.g. 1500 for 15% when scale = 10_000).
 * taxScale     – denominator for taxRate (default: DEFAULT_TAX_SCALE = 10_000).
 *
 * Warning codes
 * -------------
 * TAX_ESTIMATOR_EXCESSIVE_DIGITS   – any operand has too many digits
 * TAX_ESTIMATOR_INVALID_AMOUNT     – grossAmount is not a non-negative integer
 * TAX_ESTIMATOR_INVALID_TAX_RATE   – taxRate is not a non-negative integer
 * TAX_ESTIMATOR_INVALID_SCALE      – taxScale is not a positive integer
 * TAX_ESTIMATOR_RATE_EXCEEDS_SCALE – taxRate > taxScale (effective rate > 100%)
 * TAX_ESTIMATOR_OVERFLOW           – grossAmount x taxRate would overflow
 * TAX_ESTIMATOR_TAX_EXCEEDS_AMOUNT – computed tax exceeds gross amount
 */
export function estimateTaxDeduction(
  grossAmount: string | number | bigint,
  taxRate: string | number | bigint,
  taxScale: string | number | bigint = DEFAULT_TAX_SCALE
): TaxDeductionOutcome {
  // --- validate grossAmount ---
  const grossCheck = validateGrossAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  // --- validate taxRate ---
  const rateCheck = validateTaxRate(taxRate, "taxRate");
  if (!rateCheck.ok) {
    return rateCheck;
  }

  // --- validate taxScale ---
  const scaleCheck = validateTaxScale(taxScale, "taxScale");
  if (!scaleCheck.ok) {
    return scaleCheck;
  }

  const gross = grossCheck.value;
  const rate = rateCheck.value;
  const scale = scaleCheck.value;

  // --- semantic guard: rate must not exceed scale (> 100%) ---
  if (rate > scale) {
    return {
      ok: false,
      error: `taxRate (${rate}) exceeds taxScale (${scale}); effective tax rate would exceed 100%`,
      code: ERROR_CODES.RATE_EXCEEDS_SCALE,
    };
  }

  // --- overflow guard on intermediate product ---
  const product = gross * rate;
  if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
    return {
      ok: false,
      error:
        "tax estimation would overflow during multiplication of grossAmount x taxRate",
      code: ERROR_CODES.OVERFLOW,
    };
  }

  const taxAmount = product / scale;
  const remainder = product % scale;

  // Sanity: taxAmount must not exceed gross (guards any unexpected edge path).
  if (taxAmount > gross) {
    return {
      ok: false,
      error: "estimated tax amount exceeds gross amount",
      code: ERROR_CODES.TAX_EXCEEDS_AMOUNT,
    };
  }

  const netAmount = gross - taxAmount;

  // Express effective rate in basis points for reporting convenience.
  const BPS_SCALE = 10_000n;
  const taxRateBps =
    gross > 0n ? (taxAmount * BPS_SCALE) / gross : (rate * BPS_SCALE) / scale;

  return {
    ok: true,
    grossAmount: gross,
    taxAmount,
    netAmount,
    remainder,
    taxRateBps,
  };
}

// ---------------------------------------------------------------------------
// Progressive (bracket-based) tax estimation
// ---------------------------------------------------------------------------

/**
 * Validate a single TaxBracket entry and return the resolved upTo / rate /
 * scale BigInt triple, or an error result.
 */
function validateBracket(
  bracket: TaxBracket,
  index: number
):
  | { ok: true; upTo: bigint | null; rate: bigint; scale: bigint }
  | { ok: false; error: string; code: TaxEstimatorErrorCode } {
  const label = `brackets[${index}]`;

  // --- rate ---
  const rateCheck = validateTaxRate(bracket.rate, `${label}.rate`);
  if (!rateCheck.ok) {
    return rateCheck;
  }

  // --- scale ---
  const scaleInput =
    bracket.scale !== undefined && bracket.scale !== null
      ? bracket.scale
      : DEFAULT_TAX_SCALE;
  const scaleCheck = validateTaxScale(scaleInput, `${label}.scale`);
  if (!scaleCheck.ok) {
    return scaleCheck;
  }

  // --- semantic guard: rate must not exceed scale ---
  if (rateCheck.value > scaleCheck.value) {
    return {
      ok: false,
      error: `${label}.rate (${rateCheck.value}) exceeds ${label}.scale (${scaleCheck.value}); effective rate would exceed 100%`,
      code: ERROR_CODES.RATE_EXCEEDS_SCALE,
    };
  }

  // --- upTo ---
  if (bracket.upTo === null || bracket.upTo === undefined) {
    return {
      ok: true,
      upTo: null,
      rate: rateCheck.value,
      scale: scaleCheck.value,
    };
  }

  const upToCheck = parseIntegerInput(
    bracket.upTo,
    `${label}.upTo`,
    ERROR_CODES.INVALID_BRACKET
  );
  if (!upToCheck.ok) {
    return upToCheck;
  }
  if (upToCheck.value < 0n) {
    return {
      ok: false,
      error: `${label}.upTo must be a non-negative integer`,
      code: ERROR_CODES.INVALID_BRACKET,
    };
  }

  return {
    ok: true,
    upTo: upToCheck.value,
    rate: rateCheck.value,
    scale: scaleCheck.value,
  };
}

/**
 * Estimate the total withholding tax using a progressive bracket schedule.
 *
 * For each bracket, the taxable slice is the portion of the gross amount that
 * falls within the bracket's band.  For example:
 *
 *   brackets = [
 *     { upTo: 50_000, rate: 1000, scale: 10_000 },  // 10% on first 50,000
 *     { upTo: null,   rate: 2000, scale: 10_000 },  // 20% on the rest
 *   ]
 *   grossAmount = 80_000
 *   -> taxOnFirstBand  = 50_000 x 1000 / 10_000 = 5_000
 *   -> taxOnSecondBand = 30_000 x 2000 / 10_000 = 6_000
 *   -> totalTaxAmount  = 11_000
 *   -> netAmount       = 69_000
 *
 * The last bracket in the array must have upTo = null or undefined to act as
 * the catch-all top bracket.  Intermediate brackets must have upTo > previous
 * bracket's upTo; order is enforced to prevent miscalculations.
 *
 * Warning codes
 * -------------
 * TAX_ESTIMATOR_EMPTY_BRACKETS     – bracket schedule is empty
 * TAX_ESTIMATOR_EXCESSIVE_DIGITS   – any bracket operand has too many digits
 * TAX_ESTIMATOR_INVALID_AMOUNT     – grossAmount is invalid
 * TAX_ESTIMATOR_INVALID_TAX_RATE   – a bracket rate is invalid
 * TAX_ESTIMATOR_INVALID_SCALE      – a bracket scale is invalid
 * TAX_ESTIMATOR_INVALID_BRACKET    – a bracket upTo value is invalid
 * TAX_ESTIMATOR_RATE_EXCEEDS_SCALE – a bracket rate > its scale
 * TAX_ESTIMATOR_OVERFLOW           – intermediate multiplication overflows
 * TAX_ESTIMATOR_TAX_EXCEEDS_AMOUNT – total tax would exceed gross amount
 */
export function estimateBracketTax(
  grossAmount: string | number | bigint,
  brackets: TaxBracket[]
): BracketTaxOutcome {
  // --- validate grossAmount ---
  const grossCheck = validateGrossAmount(grossAmount, "grossAmount");
  if (!grossCheck.ok) {
    return grossCheck;
  }

  // --- validate bracket schedule is non-empty ---
  if (!Array.isArray(brackets) || brackets.length === 0) {
    return {
      ok: false,
      error: "brackets must be a non-empty array of TaxBracket entries",
      code: ERROR_CODES.EMPTY_BRACKETS,
    };
  }

  const gross = grossCheck.value;

  // --- parse and validate each bracket ---
  type ResolvedBracket = { upTo: bigint | null; rate: bigint; scale: bigint };
  const resolved: ResolvedBracket[] = [];

  for (let i = 0; i < brackets.length; i++) {
    const bracketResult = validateBracket(brackets[i], i);
    if (!bracketResult.ok) {
      return bracketResult;
    }
    resolved.push({
      upTo: bracketResult.upTo,
      rate: bracketResult.rate,
      scale: bracketResult.scale,
    });
  }

  // --- enforce ascending upTo ordering ---
  let prevUpTo: bigint | null = null;
  for (let i = 0; i < resolved.length; i++) {
    const current = resolved[i];
    if (current.upTo === null) {
      // Catch-all bracket must be the last one.
      if (i !== resolved.length - 1) {
        return {
          ok: false,
          error: `brackets[${i}] has upTo=null (catch-all) but is not the last bracket`,
          code: ERROR_CODES.INVALID_BRACKET,
        };
      }
    } else {
      if (prevUpTo !== null && current.upTo <= prevUpTo) {
        return {
          ok: false,
          error: `brackets[${i}].upTo (${current.upTo}) must be greater than the previous bracket's upTo (${prevUpTo})`,
          code: ERROR_CODES.INVALID_BRACKET,
        };
      }
    }
    prevUpTo = current.upTo;
  }

  // --- compute bracket taxes ---
  const bracketTaxes: bigint[] = [];
  let totalTaxAmount = 0n;
  let remaining = gross;
  let lowerBound = 0n;

  for (let i = 0; i < resolved.length; i++) {
    const { upTo, rate, scale } = resolved[i];

    if (remaining <= 0n) {
      bracketTaxes.push(0n);
      continue;
    }

    // Compute the taxable slice for this bracket.
    let slice: bigint;
    if (upTo === null) {
      // Top bracket: everything that remains.
      slice = remaining;
    } else {
      const bandWidth = upTo - lowerBound;
      slice = remaining < bandWidth ? remaining : bandWidth;
    }

    // Overflow guard before multiplication.
    const product = slice * rate;
    if (digitCount(product.toString()) > MAX_INTERMEDIATE_DIGITS) {
      return {
        ok: false,
        error: `tax estimation for brackets[${i}] would overflow during multiplication`,
        code: ERROR_CODES.OVERFLOW,
      };
    }

    const bracketTax = product / scale;
    bracketTaxes.push(bracketTax);
    totalTaxAmount += bracketTax;
    remaining -= slice;
    if (upTo !== null) {
      lowerBound = upTo;
    }
  }

  // --- sanity guard ---
  if (totalTaxAmount > gross) {
    return {
      ok: false,
      error: "total estimated tax exceeds gross amount",
      code: ERROR_CODES.TAX_EXCEEDS_AMOUNT,
    };
  }

  const netAmount = gross - totalTaxAmount;
  const BPS_SCALE = 10_000n;
  const effectiveRateBps =
    gross > 0n ? (totalTaxAmount * BPS_SCALE) / gross : 0n;

  return {
    ok: true,
    grossAmount: gross,
    bracketTaxes,
    totalTaxAmount,
    netAmount,
    effectiveRateBps,
  };
}
