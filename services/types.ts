export type ServiceError = {
  code: string;
  message: string;
};

export type ServiceResult<T> =
  | {
      data: T;
      error?: never;
    }
  | {
      data?: never;
      error: ServiceError;
    };
