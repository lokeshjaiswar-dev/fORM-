// Stands in for classic's UploadService: serves the contract's options exchange for the master dropdown.
import fixtures from '../../../src/embed/bridge/__fixtures__/fp-bridge-v1.fixtures.json';

export default class UploadService {
  async getDropdownOptions(masterId, fieldId, page, search) {
    const res = fixtures.optionsExchange[1].payload;
    window.__optionCalls = [...(window.__optionCalls ?? []), { masterId, fieldId, page, search }];
    return { data: { values: res.options, current_page: 1, total_pages: res.hasMore ? 2 : 1 } };
  }
  async getMasterFieldValuesWithParent() {
    return { data: { values: [], current_page: 1, total_pages: 1 } };
  }
}
