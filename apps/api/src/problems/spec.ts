/** One problem code: the HTTP status it answers with and the fixed title of its problem+json body. */
export interface ProblemSpec {
  status: number;
  title: string;
}
