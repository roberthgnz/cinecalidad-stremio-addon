/**
 * Enterprise-grade error handling system
 * Provides structured error types, codes, and context
 */

const logger = require("../../lib/logger");

class AppError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = cause;
    this.timestamp = new Date().toISOString();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to JSON for logging
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      timestamp: this.timestamp,
      stack: this.stack,
      cause: this.cause?.message,
    };
  }

  /**
   * Check if error is retryable
   */
  isRetryable() {
    const retryableCodes = [
      ErrorCodes.NETWORK_ERROR,
      ErrorCodes.TIMEOUT_ERROR,
      ErrorCodes.EXTERNAL_SERVICE_ERROR,
      ErrorCodes.RATE_LIMIT_ERROR,
    ];

    return retryableCodes.includes(this.code);
  }
}

/**
 * Standardized error codes for the application
 */
const ErrorCodes = {
  // Input/Validation Errors (4xx equivalent)
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_ID_FORMAT: "INVALID_ID_FORMAT",
  UNSUPPORTED_ID_TYPE: "UNSUPPORTED_ID_TYPE",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",

  // External Service Errors (5xx equivalent)
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  RATE_LIMIT_ERROR: "RATE_LIMIT_ERROR",

  // Data/Processing Errors
  DATA_NOT_FOUND: "DATA_NOT_FOUND",
  SCRAPING_ERROR: "SCRAPING_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",

  // System Errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

/**
 * Error factory function
 * @param code
 * @param message
 * @param cause
 */
function createError(code, message, cause = null) {
  return new AppError(code, message, cause);
}

/**
 * Specific error types for common scenarios
 */
class ValidationError extends AppError {
  constructor(message, field = null) {
    super(ErrorCodes.INVALID_INPUT, message);
    this.field = field;
  }
}

class NetworkError extends AppError {
  constructor(message, cause = null) {
    super(ErrorCodes.NETWORK_ERROR, message, cause);
  }
}

class ExternalServiceError extends AppError {
  constructor(service, message, cause = null) {
    super(ErrorCodes.EXTERNAL_SERVICE_ERROR, `${service}: ${message}`, cause);
    this.service = service;
  }
}

class DatabaseError extends AppError {
  constructor(operation, message, cause = null) {
    super(
      ErrorCodes.DATABASE_ERROR,
      `Database ${operation}: ${message}`,
      cause,
    );
    this.operation = operation;
  }
}

/**
 * Error handler middleware for consistent error responses
 */
class ErrorHandler {
  static handle(error, context = {}) {
    const isAppError = error instanceof AppError;

    const errorInfo = {
      ...context,
      error: isAppError
        ? error.toJSON()
        : {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
    };

    // Log appropriate level based on error type
    if (isAppError) {
      if (
        error.code === ErrorCodes.INVALID_INPUT ||
        error.code === ErrorCodes.INVALID_ID_FORMAT ||
        error.code === ErrorCodes.DATA_NOT_FOUND
      ) {
        // These are expected errors, log as debug/info
        logger.info("Expected error occurred", errorInfo);
      } else {
        logger.error("Application error occurred", errorInfo);
      }
    } else {
      // Unexpected errors should be logged as errors
      logger.error("Unexpected error occurred", errorInfo);
    }

    return {
      success: false,
      error: {
        code: isAppError ? error.code : ErrorCodes.INTERNAL_ERROR,
        message: error.message,
        retryable: isAppError ? error.isRetryable() : false,
      },
    };
  }

  /**
   * Async wrapper that handles promise rejections
   * @param asyncFn
   * @param context
   */
  static async asyncHandle(asyncFn, context = {}) {
    try {
      return await asyncFn();
    } catch (error) {
      return this.handle(error, context);
    }
  }
}

/**
 * Retry wrapper with exponential backoff
 */
class RetryHandler {
  static async retry(fn, options = {}) {
    const {
      maxAttempts = 3,
      initialDelay = 1000,
      maxDelay = 10000,
      backoffFactor = 2,
      shouldRetry = (error) => error instanceof AppError && error.isRetryable(),
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === maxAttempts || !shouldRetry(error)) {
          throw error;
        }

        const delay = Math.min(
          initialDelay * Math.pow(backoffFactor, attempt - 1),
          maxDelay,
        );

        logger.debug("Retrying operation", {
          attempt,
          maxAttempts,
          delay,
          error: error.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

module.exports = {
  AppError,
  ValidationError,
  NetworkError,
  ExternalServiceError,
  DatabaseError,
  ErrorCodes,
  ErrorHandler,
  RetryHandler,
  createError,
};
