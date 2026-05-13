import { IHttpMethod } from '../types';

declare var __API_SERVER_URL__;
const BACKEND_URL = (typeof __API_SERVER_URL__ === 'undefined' ? 'http://localhost:9966/petclinic' : __API_SERVER_URL__);

export const url = (path: string): string => `${BACKEND_URL}/${path}`.replace(/(?<!:)\/\//g, '/');

/**
 * path: relative PATH without host and port (i.e. '/api/123')
 * data: object that will be passed as request body
 * onSuccess: callback handler if request succeeded. Succeeded means it could technically be handled (i.e. valid json is returned)
 * regardless of the HTTP status code.
 */
export const submitForm = (method: IHttpMethod, path: string, data: any, onSuccess: (status: number, response: any) => void) => {
  const requestUrl = url(path);

  const fetchParams = {
    method: method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  };


  return fetch(requestUrl, fetchParams)
    .then(response => {
      const status = response.status;
      if (status === 204) return onSuccess(status, {});
      
      const errorsHeader = response.headers.get('errors');
      if (errorsHeader) {
        console.error("Validation errors from backend:", errorsHeader);
        return onSuccess(status, { error: "Validation failed", details: JSON.parse(errorsHeader) });
      }
      
      return response.text().then(text => {
        try {
          const result = text ? JSON.parse(text) : {};
          return onSuccess(status, result);
        } catch (e) {
          console.error("Failed to parse JSON response:", text);
          return onSuccess(status, { error: "Invalid JSON response", raw: text });
        }
      });
    });
};
