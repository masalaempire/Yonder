// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import Demo from '../src/components/Demo';
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('uses a separate simulated source and ends without network or real sensor access',()=>{const fetch=vi.fn(),geo=vi.fn(),exit=vi.fn();vi.stubGlobal('fetch',fetch);Object.defineProperty(navigator,'geolocation',{configurable:true,value:{watchPosition:geo}});render(createElement(Demo,{onExit:exit}));expect(screen.getByText('Demo · simulated')).toBeTruthy();expect(screen.getByText('Head this way')).toBeTruthy();fireEvent.click(screen.getByLabelText('Poor accuracy'));expect(screen.getByText('Location accuracy is low')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Stop sharing'}));expect(screen.getByText('The simulated session has ended.')).toBeTruthy();expect(fetch).not.toHaveBeenCalled();expect(geo).not.toHaveBeenCalled()});
