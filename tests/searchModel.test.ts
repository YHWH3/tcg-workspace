import {it,expect} from 'vitest';
import {prefixMatch,mergeSearch,SearchEpoch} from '../src/core/searchModel';
it('shares Unicode word-prefix semantics and does not match substrings',()=>{expect(prefixMatch('jalapeno cult','Jalapeño cultivar')).toBe(true);expect(prefixMatch('ulk','Bulk')).toBe(false);});
it('deduplicates local/server results, retaining current server metadata',()=>{const base={id:'r',type:'page',title:'old',url:'/pages/r'};expect(mergeSearch([{...base,source:'local'}],[{...base,title:'current',source:'server'}])).toEqual([{...base,title:'current',source:'server'}]);});
it('invalidates in-flight work across queries, account replacement and authority changes',()=>{const epoch=new SearchEpoch(),one=epoch.begin();expect(epoch.current(one)).toBe(true);const two=epoch.begin();expect(epoch.current(one)).toBe(false);expect(epoch.current(two)).toBe(true);epoch.invalidate();expect(epoch.current(two)).toBe(false);});
